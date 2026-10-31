import { managementAllows } from '../public/management-policy.js';
import { unlinkSync } from 'node:fs';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { digest, randomToken, passwordHash, equalSecret, fields, text, email, HttpError, respond } from './security.js';
import { publicUser } from './store.js';
import { assertCanRegister } from './integrations.js';

const dummyHash=`scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(64)}`;
export class Auth {
  constructor(config, store, mailer) {
    this.config=config; this.store=store; this._mailer=mailer;
    this.cookieName=config.secureCookies?'__Host-ccb_session':'ccb_session';
  }
  get mailer() { return typeof this._mailer==='function' ? this._mailer() : this._mailer; }
  cookie(req) {
    const matches=(req.headers.cookie || '').split(';').map(p=>p.trim()).filter(p=>p.startsWith(`${this.cookieName}=`));
    if(matches.length!==1) return '';
    const value=matches[0].slice(this.cookieName.length+1);
    return /^[A-Za-z0-9_-]{43}$/.test(value)?value:'';
  }
  issue(req,res,user) {
    const token=randomToken(), csrf=randomToken();
    const old=this.cookie(req);
    this.store.transaction(()=>{
      if(old) this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(old));
      this.store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      this.store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token),user.id,csrf,Date.now()+this.config.sessionMs);
    });
    res.setHeader('Set-Cookie',`${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.config.sessionMs/1000)}${this.config.secureCookies?'; Secure':''}`);
    return {user:publicUser(user),csrf_token:csrf};
  }
  require(req,admin=false) {
    const token=this.cookie(req);
    const session=token ? this.store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now()) : null;
    const user=session && this.store.db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
    if(!user || user.status!=='active') throw new HttpError(401,'authentication_required','Sign in with an active account.');
    const path=(req.url || '').split('?')[0];
    if(user.must_change_password && !['/api/auth/session','/api/auth/password','/api/auth/logout'].includes(path))throw new HttpError(403,'password_change_required','Change the temporary password before continuing.');
    if(admin && !managementAllows(user,req.method,path)) throw new HttpError(403,'admin_required','Administrator access required.');
    if(!['GET','HEAD'].includes(req.method) && !equalSecret(req.headers['x-csrf-token'],session.csrf)) throw new HttpError(403,'invalid_csrf','Refresh the session and send its CSRF token.');
    return {user,session};
  }
  async sendMail(user,kind) {
    let token='';
    if(kind==='verify' || kind==='reset') {
      const verify=kind==='verify';
      token=verify?String(randomInt(0,1000000)).padStart(6,'0'):randomToken();
      const now=Date.now();
      const tokenHash=verify?digest(`${user.id}:${token}`):digest(token);
      this.store.transaction(()=>{
        this.store.db.prepare('DELETE FROM auth_tokens WHERE (user_id=? AND kind=?) OR expires_at<=?').run(user.id,kind,now);
        this.store.db.prepare('INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at,attempts) VALUES (?,?,?,?,0)').run(tokenHash,user.id,kind,now+(verify?900000:1800000));
      });
    }
    try { await this.mailer.send(user.email,kind,token); return true; }
    catch { this.store.audit(null,`mail.${kind}`,user.id,'delivery_unknown'); return false; /* Do not log credentials, codes, links, or provider errors. */ }
  }
  async handle(req,res,path,body,features) {
    const route=`${req.method} ${path}`;
    const credentials=path.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/credentials$/);
    if(req.method==='POST'&&credentials){
      fields(body,['action','admin_password','new_password','expected_revision','reason'],['action','admin_password','expected_revision','reason']);
      if(!['reset_password','email_reset','revoke_sessions'].includes(body.action))throw new HttpError(400,'invalid_input','Unknown credential operation.');
      const actor=this.require(req,true).user, target=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(credentials[1]);
      if(!target)throw new HttpError(404,'user_not_found','Customer not found.');
      if(target.id===actor.id)throw new HttpError(409,'self_credentials','Use your own login-security page.');
      if(target.role==='admin'&&actor.management_profile!=='owner')throw new HttpError(403,'admin_required','Only the site administrator can manage staff credentials.');
      const reason=text(body.reason,'reason',500);
      this.store.throttle('admin-credentials:'+actor.id,10,600000);
      if(!await passwordHash(body.admin_password,actor.password_hash)){this.store.audit(actor.id,'user.credentials_rejected',target.id,'denied',{customer_id:target.id,details:{action:body.action,reason:'administrator_reauthentication_failed'}});throw new HttpError(403,'invalid_password','Administrator password is incorrect.');}
      const hashed=body.action==='reset_password'?await passwordHash(body.new_password):null;
      const check=()=>{const current=this.require(req,true).user;if(current.id!==actor.id||current.password_hash!==actor.password_hash||current.management_profile!==actor.management_profile)throw new HttpError(409,'account_changed','Administrator credentials changed.');const fresh=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);if(!fresh||!Number.isSafeInteger(body.expected_revision)||fresh.revision!==body.expected_revision)throw new HttpError(409,'customer_changed','Refresh the customer before changing credentials.');return fresh;};
      check();
      if(body.action==='email_reset'){
        if(!this.mailer)throw new HttpError(409,'mail_disabled','Email is not configured. Use a temporary password instead.');
        if(target.status!=='active')throw new HttpError(409,'user_inactive','Reset mail requires an active customer.');
        const sent=await this.sendMail(target,'reset');check();
        this.store.audit(actor.id,'user.reset_email',target.id,sent?'ok':'delivery_unknown',{customer_id:target.id,details:{reason}});
        respond(res,200,{user:publicUser(check(),true),delivery:sent?'sent':'unconfirmed'});return true;
      }
      this.store.transaction(()=>{
        check();
        if(hashed)this.store.db.prepare('UPDATE users SET password_hash=?,must_change_password=1,revision=revision+1 WHERE id=?').run(hashed,target.id);
        else this.store.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(target.id);
        this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
        this.store.db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(target.id);
        this.store.audit(actor.id,hashed?'user.password_reset':'user.sessions_revoke',target.id,'ok',{customer_id:target.id,details:{reason,temporary_password:Boolean(hashed),devices_revoked:false}});
      });
      respond(res,200,{user:publicUser(this.store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id),true)});return true;
    }

    if(!['POST /api/setup','POST /api/auth/login','POST /api/auth/register','POST /api/auth/resend-verification','POST /api/auth/forgot-password','POST /api/auth/reset-password','POST /api/auth/verify','GET /api/auth/session','POST /api/auth/logout','PATCH /api/auth/password'].includes(route)) return false;
    if(!['GET','HEAD'].includes(req.method)) this.store.throttle(`auth:${req.socket.remoteAddress}`,30,60000);
    switch(route) {
      case 'POST /api/setup': {
        fields(body,['setup_token','email','password','display_name'],['setup_token','email','password','display_name']);
        const setup=this.store.db.prepare("SELECT value FROM settings WHERE key='setup_hash'").get();
        if(!setup || !equalSecret(setup.value,digest(text(body.setup_token,'setup_token',128)))) throw new HttpError(403,'setup_unavailable','Setup token is invalid or already consumed.');
        const address=email(body.email), name=text(body.display_name,'display_name',100), hashed=await passwordHash(body.password);
        const user=this.store.transaction(()=>{
          const current=this.store.db.prepare("SELECT value FROM settings WHERE key='setup_hash'").get();
          if(!current || current.value!==setup.value || this.store.db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409,'setup_complete','Setup has already completed.');
          const created=this.store.createUser({email:address,display_name:name,password_hash:hashed,role:'admin',status:'active'});
          this.store.db.prepare("DELETE FROM settings WHERE key='setup_hash'").run();
          this.store.db.prepare("INSERT INTO settings VALUES ('setup_complete','true')").run();
          this.store.audit(created.id,'setup.complete',created.id);
          return created;
        });
        try { unlinkSync(this.store.setupFile); } catch { /* Consumed secret cannot bootstrap again even if file cleanup fails. */ }
        respond(res,201,this.issue(req,res,user)); break;
      }
      case 'POST /api/auth/login': {
        fields(body,['email','password'],['email','password']);
        const address=email(body.email);
        this.store.throttle(`login:${digest(address)}`,15,60000);
        const user=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);
        const valid=await passwordHash(body.password,user?.password_hash || dummyHash);
        const current=user && this.store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        if(!valid || !current || current.status!=='active' || current.password_hash!==user.password_hash) throw new HttpError(401,'invalid_credentials','Invalid credentials or account unavailable.');
        this.store.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(),current.id);
        this.store.audit(current.id,'auth.login',current.id);
        respond(res,200,this.issue(req,res,current)); break;
      }
      case 'GET /api/auth/session': {
        const {user,session}=this.require(req); respond(res,200,{user:publicUser(user),csrf_token:session.csrf}); break;
      }
      case 'POST /api/auth/logout': {
        fields(body,[]);
        const {user,session}=this.require(req);
        this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
        res.setHeader('Set-Cookie',`${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies?'; Secure':''}`);
        this.store.audit(user.id,'auth.logout',user.id);
        respond(res,200,{ok:true}); break;
      }
      case 'POST /api/auth/register': {
        if(!features.registration) throw new HttpError(503,'registration_disabled','Registration requires administrator enablement.');
        if(features.email_verification && !this.mailer) throw new HttpError(503,'registration_disabled','Registration requires configured email verification and administrator enablement.');
        fields(body,['email','password','display_name'],['email','password','display_name']);
        const address=email(body.email), name=text(body.display_name,'display_name',100), hashed=await passwordHash(body.password);
        this.store.throttle(`register:${digest(address)}`,3,3600000);
        const user=this.store.transaction(()=>{
          const existing=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);
          if(!existing) {
            assertCanRegister(this.store, address);
            const status=features.email_verification?'pending_verification':'active';
            const added=this.store.createUser({email:address,display_name:name,password_hash:hashed,role:'member',status});
            this.store.audit(added.id,'auth.register',added.id);
            return added;
          }
          if(existing.status==='pending_verification' && features.email_verification) {
            const updated=this.store.db.prepare("UPDATE users SET password_hash=?,display_name=? WHERE id=? AND status='pending_verification'").run(hashed,name,existing.id);
            if(updated.changes===1) this.store.audit(existing.id,'auth.register_refresh',existing.id);
          }
          return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
        });
        const verifying=features.email_verification;
        let delivery=verifying?'sent':'not_required';
        if(verifying) {
          const kind=user.status==='pending_verification'?'verify':user.status==='active'?'login':'unavailable';
          if(!await this.sendMail(user,kind)) delivery='unconfirmed';
        }
        respond(res,200,{status:verifying?'verification_required':'created',delivery}); break;
      }
      case 'POST /api/auth/resend-verification': {
        if(!this.mailer) throw new HttpError(503,'mail_disabled','Email verification and reset are not configured.');
        fields(body,['email'],['email']);
        const address=email(body.email);
        this.store.throttle(`register:${digest(address)}`,3,3600000);
        const user=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);
        if(user?.status==='pending_verification') await this.sendMail(user,'verify');
        else if(user?.status==='active') await this.sendMail(user,'login');
        else if(user?.status==='disabled') await this.sendMail(user,'unavailable');
        respond(res,200,{ok:true}); break;
      }
      case 'POST /api/auth/forgot-password': {
        fields(body,['email'],['email']);
        const address=email(body.email);
        this.store.throttle(`reset:${digest(address)}`,3,3600000);
        if(this.mailer) {
          const user=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);
          if(user?.status==='active') await this.sendMail(user,'reset');
          else if(user?.status==='pending_verification') await this.sendMail(user,'verify');
          else if(user?.status==='disabled') await this.sendMail(user,'unavailable');
        }
        respond(res,200,{ok:true}); break;
      }
      case 'POST /api/auth/verify': {
        if(!this.mailer) throw new HttpError(503,'mail_disabled','Email verification and reset are not configured.');
        fields(body,['email','code'],['email','code']);
        const address=email(body.email), code=text(body.code,'code',6);
        if(!/^\d{6}$/.test(code)) throw new HttpError(400,'invalid_code','Verification code is invalid, expired, or already used.');
        const matches=this.store.db.prepare('SELECT * FROM users WHERE email=? OR pending_email=?').all(address,address);
        const user=matches.length===1?matches[0]:null;
        const pending=Boolean(user && user.pending_email===address);
        const registration=Boolean(user && !user.pending_email && user.email===address && user.status==='pending_verification');
        const token=user && (pending || registration) ? this.store.db.prepare("SELECT * FROM auth_tokens WHERE user_id=? AND kind='verify' AND expires_at>?").get(user.id,Date.now()) : null;
        const expected=digest(user ? `${user.id}:${code}` : `absent:${address}:${code}`);
        const actual=token?.token_hash || digest(`absent:${address}:000000`);
        const same=Buffer.byteLength(actual)===Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
        if(!token || !same) {
          if(token) this.store.transaction(()=>{
            const row=this.store.db.prepare('UPDATE auth_tokens SET attempts=attempts+1 WHERE token_hash=? RETURNING attempts').get(token.token_hash);
            if(row?.attempts>=5) this.store.db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(token.token_hash);
          });
          throw new HttpError(400,'invalid_code','Verification code is invalid, expired, or already used.');
        }
        this.store.transaction(()=>{
          const consumed=this.store.db.prepare("DELETE FROM auth_tokens WHERE token_hash=? AND kind='verify' AND expires_at>?").run(token.token_hash,Date.now());
          if(consumed.changes!==1) throw new HttpError(400,'invalid_code','Verification code is invalid, expired, or already used.');
          if(pending) {
            const updated=this.store.db.prepare('UPDATE users SET email=?,pending_email=NULL,revision=revision+1 WHERE id=? AND pending_email=?').run(address,user.id,address);
            if(updated.changes!==1) throw new HttpError(409,'account_changed','Account changed; request a new code.');
          } else {
            const updated=this.store.db.prepare("UPDATE users SET status='active',revision=revision+1 WHERE id=? AND status='pending_verification' AND pending_email IS NULL").run(user.id);
            if(updated.changes!==1) throw new HttpError(409,'account_changed','Account changed; request a new code.');
          }
          this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
          this.store.db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND kind='verify'").run(user.id);
          this.store.audit(user.id,'auth.verify',user.id);
        });
        respond(res,200,{ok:true}); break;
      }
      case 'POST /api/auth/reset-password': {
        if(!this.mailer) throw new HttpError(503,'mail_disabled','Email verification and reset are not configured.');
        fields(body,['token','password'],['token','password']);
        const tokenHash=digest(text(body.token,'token',128));
        const token=this.store.db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?").get(tokenHash,Date.now());
        if(!token) throw new HttpError(400,'invalid_token','Link is invalid, expired, or already used.');
        const hashed=await passwordHash(body.password);
        this.store.transaction(()=>{
          const consumed=this.store.db.prepare('DELETE FROM auth_tokens WHERE token_hash=? AND expires_at>?').run(tokenHash,Date.now());
          if(consumed.changes!==1) throw new HttpError(400,'invalid_token','Link is invalid, expired, or already used.');
          this.store.db.prepare('UPDATE users SET password_hash=?,must_change_password=0,revision=revision+1 WHERE id=?').run(hashed,token.user_id);
          this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(token.user_id);
          this.store.db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND kind='reset'").run(token.user_id);
          this.store.audit(token.user_id,'auth.reset',token.user_id);
        });
        respond(res,200,{ok:true}); break;
      }
      case 'PATCH /api/auth/password': {
        fields(body,['current_password','new_password'],['current_password','new_password']);
        const {user}=this.require(req);
        if(!await passwordHash(body.current_password,user.password_hash)) throw new HttpError(403,'invalid_password','Current password is incorrect.');
        if(body.current_password===body.new_password)throw new HttpError(400,'invalid_password','Choose a different new password.');
        const hashed=await passwordHash(body.new_password);
        this.store.transaction(()=>{
          const updated=this.store.db.prepare("UPDATE users SET password_hash=?,must_change_password=0,revision=revision+1 WHERE id=? AND password_hash=? AND status='active'").run(hashed,user.id,user.password_hash);
          if(updated.changes!==1) throw new HttpError(409,'account_changed','Account changed; sign in again.');
          this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
          this.store.db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(user.id);
          this.store.audit(user.id,'auth.password',user.id);
        });
        res.setHeader('Set-Cookie',`${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies?'; Secure':''}`);
        respond(res,200,{ok:true}); break;
      }
    }
    return true;
  }
}
