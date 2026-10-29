// One policy shared by route presentation and server authorization. Unknown profiles fail closed.
export const managementProfiles = {owner:'站点管理员',support:'客服',operations:'运营',finance:'财务',observer:'只读审计'};
export function managementAllows(user,method,path) {
 if(user?.role!=='admin')return false;
 const profile=user.management_profile || 'owner';
 if(profile==='owner')return true;
 if(!Object.hasOwn(managementProfiles,profile))return false;
 const read=method==='GET'||method==='HEAD';
 if(read) return /^\/api\/admin\/(users|customers|customer-usage|devices|inventory|allocation-batches|operations|grants|orders|rentals|plans|audit)(?:\/|$)/.test(path);
 if(profile==='observer')return false;
 if(/\/users\/[^/]+\/credentials$/.test(path))return profile==='support';
 if(/\/users(?:\/[^/]+)?$/.test(path))return ['support','operations'].includes(profile);
 if(/\/users\/[^/]+\/devices(?:\/|$)/.test(path))return ['support','operations'].includes(profile);
 if(/\/(grants|allocation-batches)(?:\/|$)/.test(path))return profile==='operations';
 if(/\/users\/[^/]+\/provision$/.test(path))return profile==='operations';
 if(/\/(orders|rentals|payments|plans)(?:\/|$)/.test(path))return profile==='finance';
 return false;
}
