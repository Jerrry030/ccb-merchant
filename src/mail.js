import nodemailer from "nodemailer";
import { HttpError } from "./security.js";

function transportOptions(mail) {
  return { host:mail.host, port:mail.port, secure:mail.secure===true, requireTLS:mail.requireTLS===true, auth:mail.auth, pool:false, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000, logger:false, debug:false, tls:{ rejectUnauthorized:true }, disableFileAccess:true, disableUrlAccess:true };
}

export function mailMessage(kind, secret) {
  if (kind === "verify") return {
    subject: "你的邮箱验证码",
    text: `验证码：${secret}\n\n请在 15 分钟内回到验证页面，输入这 6 位数字。验证码只能使用 5 次，只确认这个邮箱，不会修改已经可以登录的账户密码。如果不是你本人操作，请忽略这封邮件。`,
  };
  if (kind === "reset") return {
    subject: "重置你的登录密码",
    text: `请在 30 分钟内打开下面的链接，设置新密码：\n${secret}\n\n打开页面后还需要确认一次。如果不是你本人申请，请忽略这封邮件，原密码仍然有效。`,
  };
  if (kind === "login") return {
    subject: "这个邮箱已经注册",
    text: "这个邮箱已经有可以登录的账户。刚才的注册没有修改密码，也没有创建新账户。请使用原密码登录，或在登录页选择「忘记密码」。\n\n如果不是你本人操作，请忽略这封邮件。",
  };
  if (kind === "unavailable") return {
    subject: "这个邮箱暂时不能登录",
    text: "这个邮箱已有账户，但当前不能登录。刚才的注册没有修改密码。请联系商户管理员。\n\n如果不是你本人操作，请忽略这封邮件。",
  };
  throw new HttpError(400, "invalid_input", "Unknown mail kind.");
}

function resendHost(mail) {
  return mail?.host === "smtp.resend.com";
}

async function resendRequest(mail, path, body, fetchImpl) {
  const key = mail.auth?.pass;
  if (!key) throw new HttpError(503, "mail_auth_failed", "Resend API key is missing.");
  let response;
  try {
    response = await fetchImpl(`https://api.resend.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new HttpError(503, timedOut ? "mail_timeout" : "mail_unavailable", "Resend API request failed.");
  }
  if (response.ok) return;
  const code = response.status === 401 || response.status === 403 ? "mail_auth_failed" : response.status === 422 ? "mail_recipient_rejected" : "mail_unavailable";
  throw new HttpError(503, code, "Resend API rejected the request.");
}

export function createMailer(config, fetchImpl = globalThis.fetch) {
  if (!config.mail) return null;
  const from = config.mail.from;
  const compose = (email, kind, token) => {
    const link = token && kind !== "verify" ? `${config.publicOrigin}/reset?token=${encodeURIComponent(token)}` : "";
    const message = mailMessage(kind, kind === "verify" ? token : link);
    return { from, to: email, subject: message.subject, text: message.text };
  };
  if (resendHost(config.mail)) return {
    async send(email, kind, token) {
      const message = compose(email, kind, token);
      await resendRequest(config.mail, "/emails", { from: message.from, to: [message.to], subject: message.subject, text: message.text }, fetchImpl);
    },
  };
  const transport = nodemailer.createTransport(transportOptions(config.mail));
  return {
    async send(email, kind, token) {
      const message = compose(email, kind, token);
      await transport.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
    },
  };
}

export async function testMail(mail, recipient, transportFactory = nodemailer.createTransport, fetchImpl = globalThis.fetch) {
  if (resendHost(mail)) {
    if (recipient) {
      await resendRequest(mail, "/emails", {
        from: mail.from, to: [recipient], subject: "SMTP 测试邮件",
        text: "这是一封用于验证当前 SMTP 配置的测试邮件。收到邮件说明本次投递成功。此测试不会保存配置或修改注册设置。",
      }, fetchImpl);
      return { ok: true, mode: "send", recipient };
    }
    await resendRequest(mail, "/domains", undefined, fetchImpl);
    return { ok: true, mode: "connection" };
  }
  const transport = transportFactory(transportOptions(mail));
  try {
    if (recipient) {
      const result = await transport.sendMail({
        from: mail.from, to: recipient, subject: "SMTP 测试邮件",
        text: "这是一封用于验证当前 SMTP 配置的测试邮件。收到邮件说明本次投递成功。此测试不会保存配置或修改注册设置。",
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!result.accepted?.some(address => address.toLowerCase() === recipient.toLowerCase())) throw new HttpError(503, "mail_recipient_rejected", "SMTP rejected the test recipient.");
      return { ok: true, mode: "send", recipient };
    }
    await transport.verify();
    return { ok: true, mode: "connection" };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = error.code === "EAUTH" ? "mail_auth_failed" : error.code === "ETIMEDOUT" ? "mail_timeout" : ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(error.code) ? "mail_tls_failed" : "mail_unavailable";
    throw new HttpError(503, code, "SMTP test failed. Check the connection, TLS settings and credentials.");
  } finally { transport.close(); }
}
