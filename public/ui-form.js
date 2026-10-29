import { el, icon } from './dom.js';
import { toast, errorNotice } from './ui.js';
import { render } from './app.js';
export const CANCEL = Symbol('cancel');
let fieldSequence = 0;
export function field(label, name, options = {}) {
  const {type = 'text',hint,value,choices,...props} = options;
  const control = type === 'select' ? el('select',{name,...props},(choices || []).map(c => el('option',{value:c.value,text:c.label,disabled:c.disabled})))
    : el(type === 'textarea' ? 'textarea' : 'input',{name,...(type === 'textarea' ? {} : {type}),...props});
  if (value != null) control.value = value;
  const id = `field-${++fieldSequence}`;
  control.id = id; control.setAttribute('aria-labelledby',`${id}-label`);
  if (hint) control.setAttribute('aria-describedby',`${id}-hint`);
  return el('label',{class:'field',for:id},el('span',{id:`${id}-label`,text:label}),control,hint ? el('small',{id:`${id}-hint`,text:hint}) : null);
}
export function confirmAction(title, description, label = '确认操作', danger = false) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = el('dialog',{class:'dialog','aria-labelledby':'confirm-title'},
      el('div',{class:'dialog-head'},el('h2',{id:'confirm-title',text:title})),el('p',{text:description}));
    const cancel = el('button',{class:'btn',type:'button',text:'取消',onclick:() => dialog.close('cancel')});
    dialog.append(el('div',{class:'dialog-actions'},cancel,el('button',{class:`btn ${danger ? 'danger' : 'primary'}`,type:'button',text:label,onclick:() => dialog.close('confirm')})));
    dialog.addEventListener('close',() => { const confirmed = dialog.returnValue === 'confirm'; dialog.remove(); if (previous?.isConnected) previous.focus(); resolve(confirmed); },{once:true});
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
export function bindForm(form, handler, success) {
  const message = el('div',{class:'form-message'}); form.prepend(message);
  form.addEventListener('submit',async event => {
    event.preventDefault(); if (form.dataset.busy === 'true') return;
    const values = new FormData(form); const controls = [...form.querySelectorAll('button,input,select,textarea')].map(node => [node,node.disabled]);
    form.dataset.busy = 'true'; form.setAttribute('aria-busy','true'); controls.forEach(([node]) => node.disabled = true); message.replaceChildren();
    let uncertain = false;
    try {
      const result = await handler(values);
      if (result !== CANCEL && form.isConnected) {
        form.querySelectorAll('input[type=password]').forEach(node => node.value = '');
        await success?.(result,message);
      }
    } catch (error) {
      uncertain = Boolean(error.uncertain); message.replaceChildren(errorNotice(error)); message.scrollIntoView({block:'nearest'});
    } finally {
      form.dataset.busy = 'false'; form.removeAttribute('aria-busy'); controls.forEach(([node,disabled]) => node.disabled = disabled || (uncertain && node.type === 'submit'));
    }
  });
}
export function actionButton(label, handler, {danger = false, disabled = false, onSuccess} = {}) {
  const button = el('button',{type:'button',class:`btn small ${danger ? 'danger' : ''}`,text:label,disabled,onclick:async () => {
    button.disabled = true;
    try { const result = await handler(); if (result !== CANCEL) { toast('操作已由服务器确认'); if (onSuccess) await onSuccess(result); else render(); } }
    catch (error) {
      const host = document.getElementById('page-feedback'); host?.replaceChildren(errorNotice(error)); host?.scrollIntoView({block:'nearest'});
      if (error.uncertain) return;
    }
    button.disabled = disabled;
  }}); return button;
}
export function editorDialog(title, form) {
  const previous = document.activeElement;
  const dialog = el('dialog',{class:'dialog','aria-label':title});
  dialog.append(el('div',{class:'dialog-head'},el('h2',{text:title}),el('button',{class:'icon-button',type:'button','aria-label':'关闭对话框',onclick:() => dialog.close()},icon('close'))),form);
  dialog.addEventListener('close',() => { form.querySelectorAll('input[type=password]').forEach(n => n.value = ''); dialog.remove(); if (previous?.isConnected) previous.focus(); },{once:true});
  document.body.append(dialog); dialog.showModal(); return dialog;
}
export function switchRow(title, hint, name, checked) {
  return el('div',{class:'switch-row'},el('div',{},el('strong',{text:title}),el('p',{text:hint})),el('label',{class:'switch'},el('input',{type:'checkbox',name,'aria-label':title,checked:checked===true}),el('span')));
}
