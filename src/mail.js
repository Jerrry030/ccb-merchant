import nodemailer from 'nodemailer';
import { HttpError } from './security.js';

function transportOptions(mail) {
  return { host:mail.host, port:mail.port, secure:mail.secure===true, requireTLS:mail.requireTLS===true, auth:mail.auth, pool:false, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000, logger:false, debug:false, tls:{ rejectUnauthorized:true }, disableFileAccess:true, disableUrlAccess:true };
}
export function createMailer(config) {
  if (!config.mail) return null;
  const from = config.mail.from;
  const transport = nodemailer.createTransport(transportOptions(config.mail));
  return {
    async send(email, kind, token) {
      const verification=kind==='verify';
      const link=`${config.publicOrigin}/${verification?'verify':'reset'}?token=${encodeURIComponent(token)}`;
      await transport.sendMail({ from, to:email, subject:verification?'Verify your merchant account':'Reset your merchant password', text:`${verification?'Verify your email':'Reset your password'} using this one-time link:\n${link}\n\nIf you did not request this, ignore this email.`, disableFileAccess:true, disableUrlAccess:true });
    },
  };
}

export async function testMail(mail, recipient, transportFactory = nodemailer.createTransport) {
  const transport = transportFactory(transportOptions(mail));
  try {
    if (recipient) {
      const result = await transport.sendMail({
        from: mail.from, to: recipient, subject: 'SMTP 测试邮件',
        text: '这是一封用于验证当前 SMTP 配置的测试邮件。收到邮件说明本次投递成功。此测试不会保存配置或修改注册设置。',
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!result.accepted?.some(address => address.toLowerCase() === recipient.toLowerCase())) throw new HttpError(503, 'mail_recipient_rejected', 'SMTP rejected the test recipient.');
      return { ok: true, mode: 'send', recipient };
    }
    await transport.verify();
    return { ok: true, mode: 'connection' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = error.code === 'EAUTH' ? 'mail_auth_failed' : error.code === 'ETIMEDOUT' ? 'mail_timeout' : ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code) ? 'mail_tls_failed' : 'mail_unavailable';
    throw new HttpError(503, code, 'SMTP test failed. Check the connection, TLS settings and credentials.');
  } finally { transport.close(); }
}
