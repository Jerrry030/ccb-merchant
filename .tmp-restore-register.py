from pathlib import Path
p = Path("src/auth.js")
src = p.read_text(encoding="utf-8")
nl = "\r\n" if "\r\n" in src else "\n"
old = (
    "return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);" + nl
    + "        });" + nl
    + "      case 'POST /api/auth/resend-verification': {"
)
insert = (
    "return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);" + nl
    + "        });" + nl
    + "        const verifying=features.email_verification;" + nl
    + "        let delivery=verifying?'sent':'not_required';" + nl
    + "        if(verifying) {" + nl
    + "          const kind=user.status==='pending_verification'?'verify':user.status==='active'?'login':'unavailable';" + nl
    + "          if(!await this.sendMail(user,kind)) delivery='unconfirmed';" + nl
    + "        }" + nl
    + "        respond(res,200,{status:verifying?'verification_required':'created',delivery}); break;" + nl
    + "      }" + nl
    + "      case 'POST /api/auth/resend-verification': {"
)
count = src.count(old)
if count != 1:
    raise SystemExit(f"pattern count {count}")
p.write_text(src.replace(old, insert, 1), encoding="utf-8", newline=nl)
print("restored")
