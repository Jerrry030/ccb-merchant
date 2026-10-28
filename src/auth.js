import { unlinkSync } from 'node:fs';
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
    if(admin && user.role!=='admin') throw new HttpError(403,'admin_required','Administrator access required.');
    if(!['GET','HEAD'].includes(req.method) && !equalSecret(req.headers['x-csrf-token'],session.csrf)) throw new HttpError(403,'invalid_csrf','Refresh the session and send its CSRF token.');
    return {user,session};
  }
  async sendMail(user,kind) {
    let token='';
    if(kind==='verify' || kind==='reset') {
      token=randomToken();
      const now=Date.now();
      this.store.transaction(()=>{
        this.store.db.prepare('DELETE FROM auth_tokens WHERE (user_id=? AND kind=?) OR expires_at<=?').run(user.id,kind,now);
        this.store.db.prepare('INSERT INTO auth_tokens VALUES (?,?,?,?)').run(digest(token),user.id,kind,now+(kind==='verify'?86400000:1800000));
      });
    }
    try { await this.mailer.send(user.email,kind,token); return true; }
    catch { this.store.audit(null,`mail.${kind}`,user.id,'delivery_unknown'); return false; /* Do not log credentials, links, or provider errors. */ }
  }
  async handle(req,res,path,body,features) {
    const route=`${req.method} ${path}`;
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
      case 'POST /api/auth/verify':
      case 'POST /api/auth/reset-password': {
        if(!this.mailer) throw new HttpError(503,'mail_disabled','Email verification and reset are not configured.');
        const reset=path.endsWith('reset-password');
        fields(body,reset?['token','password']:['token'],reset?['token','password']:['token']);
        const tokenHash=digest(text(body.token,'token',128));
        const token=this.store.db.prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND kind=? AND expires_at>?').get(tokenHash,reset?'reset':'verify',Date.now());
        if(!token) throw new HttpError(400,'invalid_token','Link is invalid, expired, or already used.');
        const hashed=reset?await passwordHash(body.password):null;
        this.store.transaction(()=>{
          const consumed=this.store.db.prepare('DELETE FROM auth_tokens WHERE token_hash=? AND expires_at>?').run(tokenHash,Date.now());
          if(consumed.changes!==1) throw new HttpError(400,'invalid_token','Link is invalid, expired, or already used.');
          if(reset) this.store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashed,token.user_id);
          else this.store.db.prepare("UPDATE users SET status='active' WHERE id=? AND status='pending_verification'").run(token.user_id);
          this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(token.user_id);
          this.store.db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND kind=?').run(token.user_id,reset?'reset':'verify');
          this.store.audit(token.user_id,reset?'auth.reset':'auth.verify',token.user_id);
        });
        respond(res,200,{ok:true}); break;
      }
      case 'PATCH /api/auth/password': {
        fields(body,['current_password','new_password'],['current_password','new_password']);
        const {user}=this.require(req);
        if(!await passwordHash(body.current_password,user.password_hash)) throw new HttpError(403,'invalid_password','Current password is incorrect.');
        const hashed=await passwordHash(body.new_password);
        this.store.transaction(()=>{
          const updated=this.store.db.prepare("UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND status='active'").run(hashed,user.id,user.password_hash);
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
