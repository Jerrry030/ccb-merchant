import { el, icon } from './dom.js';
let metricPopover = null;
export function closeMetricPopover() {
  if (!metricPopover) return;
  metricPopover.button.setAttribute('aria-expanded','false');
  metricPopover.panel.remove();
  metricPopover = null;
}
function placeMetricPopover(button, panel) {
  const margin = 8;
  const rect = button.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  let left = rect.right + 10;
  if (left + width > innerWidth - margin) left = Math.max(margin, rect.left - width - 10);
  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, innerHeight - height - margin));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
function openMetricPopover(button, panel) {
  if (metricPopover?.button === button && metricPopover.panel.isConnected) return;
  closeMetricPopover();
  document.body.append(panel);
  placeMetricPopover(button, panel);
  button.setAttribute('aria-expanded','true');
  metricPopover = {button, panel, pinned:false};
}
export function metricInfo(label, build) {
  const button = el('button',{type:'button',class:'metric-info','aria-label':label,'aria-expanded':'false','aria-haspopup':'dialog'},icon('info'));
  const show = () => openMetricPopover(button, build());
  button.addEventListener('mouseenter', show);
  button.addEventListener('focus', show);
  button.addEventListener('mouseleave', () => { if (metricPopover?.button === button && !metricPopover.pinned && document.activeElement !== button) closeMetricPopover(); });
  button.addEventListener('blur', () => { if (metricPopover?.button === button && !metricPopover.pinned) closeMetricPopover(); });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (metricPopover?.button === button && metricPopover.pinned) closeMetricPopover();
    else { show(); if (metricPopover?.button === button) metricPopover.pinned = true; }
  });
  return button;
}
document.addEventListener('click', event => { if (metricPopover?.pinned && !metricPopover.button.contains(event.target)) closeMetricPopover(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMetricPopover(); });
addEventListener('scroll', () => closeMetricPopover(), true);
addEventListener('resize', () => { if (metricPopover) placeMetricPopover(metricPopover.button, metricPopover.panel); });
function detailRow(row) {
  return el('div',{class:`metric-popover-row${row.total ? ' total' : ''}`},
    el('span',{},row.label, row.tag ? el('span',{class:`token-tag${row.tag === '1h' ? ' hour' : ''}`,text:row.tag}) : null),
    el('strong',{text:row.value}));
}
export function detailPopover(title, rows, note, extraClass) {
  return el('div',{class:`metric-popover${extraClass ? ' ' + extraClass : ''}`,role:'dialog','aria-label':title},
    el('p',{class:'metric-popover-title',text:title}),
    el('div',{class:'metric-popover-list'},rows.map(detailRow)),
    note ? el('p',{class:'metric-popover-note',text:note}) : null);
}
