import nodemailer from 'nodemailer';

export function createMailer(config) {
  if (!config.mail) return null;
  const { from, ...smtp } = config.mail;
  const transport = nodemailer.createTransport({ ...smtp, pool:false, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000, logger:false, debug:false, tls:{ rejectUnauthorized:true }, disableFileAccess:true, disableUrlAccess:true });
  return {
    async send(email, kind, token) {
      const verification=kind==='verify';
      const link=`${config.publicOrigin}/${verification?'verify':'reset'}?token=${encodeURIComponent(token)}`;
      await transport.sendMail({ from, to:email, subject:verification?'Verify your merchant account':'Reset your merchant password', text:`${verification?'Verify your email':'Reset your password'} using this one-time link:\n${link}\n\nIf you did not request this, ignore this email.`, disableFileAccess:true, disableUrlAccess:true });
    },
  };
}

