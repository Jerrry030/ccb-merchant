export const app = document.getElementById('app');
export const state = { public: null, user: null, csrf: null, returnTo: '/', code: '', token: '', view: 0, scopedCustomer: null };
export function adoptSession(data) {
  if (!data.user || !['admin','member'].includes(data.user.role) || typeof data.csrf_token !== 'string' || !data.csrf_token) throw new Error('登录响应不完整，请重新登录。');
  state.user = data.user; state.csrf = data.csrf_token;
}
