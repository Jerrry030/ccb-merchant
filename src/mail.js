import nodemailer from "nodemailer";
import { HttpError } from "./security.js";

function transportOptions(mail) {
  return { host:mail.host, port:mail.port, secure:mail.secure===true, requireTLS:mail.requireTLS===true, auth:mail.auth, pool:false, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000, logger:false, debug:false, tls:{ rejectUnauthorized:true }, disableFileAccess:true, disableUrlAccess:true };
}

export function mailMessage(kind, link) {
  if (kind === "verify") return {
    subject: "验证你的账户邮箱",
    text: `请在 24 小时内打开下面的链接，完成邮箱验证：\n${link}\n\n打开页面后还需要确认一次。如果这是尚未验证的账户，登录密码以你最近一次在注册页填写的为准。如果不是你本人操作，请不要打开链接。`,
  };
  if (kind === "reset") return {
    subject: "重置你的登录密码",
    text: `请在 30 分钟内打开下面的链接，设置新密码：\n${link}\n\n打开页面后还需要确认一次。如果不是你本人申请，请忽略这封邮件，原密码仍然有效。`,
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

export function createMailer(config) {
  if (!config.mail) return null;
  const from = config.mail.from;
  const transport = nodemailer.createTransport(transportOptions(config.mail));
  return {
    async send(email, kind, token) {
      const link = token ? `${config.publicOrigin}/${kind === "verify" ? "verify" : "reset"}?token=${encodeURIComponent(token)}` : "";
      const message = mailMessage(kind, link);
      await transport.sendMail({ from, to:email, subject:message.subject, text:message.text, disableFileAccess:true, disableUrlAccess:true });
    },
  };
}

export async function testMail(mail, recipient, transportFactory = nodemailer.createTransport) {
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
