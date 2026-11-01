import { readFileSync, writeFileSync } from "node:fs";
const path = "src/auth.js";
const src = readFileSync(path, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);
function findLine(text, from = 0) {
  const i = lines.findIndex((line, idx) => idx >= from && line.includes(text));
  if (i < 0) throw new Error("missing " + text);
  return i;
}
const registerAt = findLine("case 'POST /api/auth/register':");
const resendAt = findLine("case 'POST /api/auth/resend-verification':");
const register = [
  "      case 'POST /api/auth/register': {",
  "        if(!features.registration) throw new HttpError(503,'registration_disabled','Registration requires administrator enablement.');",
  "        if(features.email_verification && !this.mailer) throw new HttpError(503,'registration_disabled','Registration requires configured email verification and administrator enablement.');",
  "        const emailOnly=body.password===undefined && body.display_name===undefined;",
  "        if(emailOnly) {",
  "          if(!features.email_verification) throw new HttpError(400,'invalid_input','Unexpected or missing request fields.');",
  "          fields(body,['email'],['email']);",
  "        } else fields(body,['email','password','display_name'],['email','password','display_name']);",
  "        const address=email(body.email), name=emailOnly?null:text(body.display_name,'display_name',100), hashed=emailOnly?null:await passwordHash(body.password);",
  "        const placeholder=emailOnly?await passwordHash(randomToken()):null;",
  "        this.store.throttle(`register:${digest(address)}`,3,3600000);",
  "        const user=this.store.transaction(()=>{",
  "          const existing=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);",
  "          if(!existing) {",
  "            assertCanRegister(this.store, address);",
  "            const status=features.email_verification?'pending_verification':'active';",
  "            const added=this.store.createUser({email:address,display_name:emailOnly?'未命名':name,password_hash:emailOnly?placeholder:hashed,role:'member',status});",
  "            if(emailOnly) this.store.db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(added.id);",
  "            this.store.audit(added.id,'auth.register',added.id);",
  "            return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(added.id);",
  "          }",
  "          if(existing.status==='pending_verification' && features.email_verification && !emailOnly) {",
  "            const updated=this.store.db.prepare(\"UPDATE users SET password_hash=?,display_name=?,must_change_password=0 WHERE id=? AND status='pending_verification'\").run(hashed,name,existing.id);",
  "            if(updated.changes===1) this.store.audit(existing.id,'auth.register_refresh',existing.id);",
  "          }",
  "          return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);",
  "        });",
].join(nl);
const verifyFields = findLine("fields(body,['email','code'],['email','code']);");
lines[verifyFields] = "        fields(body,['email','code','password','display_name'],['email','code']);";
let failThrow = -1;
for (let i = verifyFields; i < lines.length; i++) {
  if (lines[i].includes("throw new HttpError(400,'invalid_code','Verification code is invalid, expired, or already used.');") && lines[i + 2] && lines[i + 2].includes("this.store.transaction(()=>{")) {
    failThrow = i;
    break;
  }
}
if (failThrow < 0) throw new Error("token failure throw missing");
const inserted = [
  "        const choosePassword=registration && (Boolean(user.must_change_password) || body.password!==undefined || body.display_name!==undefined);",
  "        if(choosePassword && (body.password===undefined || body.display_name===undefined)) throw new HttpError(400,'invalid_input','Password and display name are required to finish registration.');",
  "        const nextName=choosePassword?text(body.display_name,'display_name',100):null;",
  "        const nextHash=choosePassword?await passwordHash(body.password):null;",
];
lines.splice(failThrow + 2, 0, ...inserted);
const activate = lines.findIndex((line, idx) => idx > failThrow && line.includes("UPDATE users SET status='active',revision=revision+1 WHERE id=? AND status='pending_verification'"));
if (activate < 0) throw new Error("activate missing");
lines.splice(activate, 1,
  "            const updated=nextHash",
  "              ? this.store.db.prepare(\"UPDATE users SET status='active',password_hash=?,display_name=?,must_change_password=0,revision=revision+1 WHERE id=? AND status='pending_verification' AND pending_email IS NULL\").run(nextHash,nextName,user.id)",
  "              : this.store.db.prepare(\"UPDATE users SET status='active',revision=revision+1 WHERE id=? AND status='pending_verification' AND pending_email IS NULL\").run(user.id);",
);
const next = [...lines.slice(0, registerAt), ...register.split(/\r?\n/), ...lines.slice(resendAt)];
writeFileSync(path, next.join(nl));
console.log("patched");
