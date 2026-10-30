export const companyPage = String.raw`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>اهداف و پروژه‌ها</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}*{box-sizing:border-box}body{margin:0;line-height:1.75}header,main{max-width:1100px;margin:auto;padding:16px}header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid GrayText}h1{font-size:1.3rem;margin:0;flex:1}h2{font-size:1.1rem;margin:0 0 8px}h3{font-size:1rem}a{color:LinkText}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;min-height:44px;padding:6px 14px;border:1px solid GrayText;border-radius:12px;background:ButtonFace}input,select,textarea{width:100%;padding:8px;border:1px solid GrayText;border-radius:10px;background:Field;color:FieldText}textarea{min-height:88px;resize:vertical}label{display:grid;gap:5px}form{display:grid;gap:12px;margin-block:12px}details{border-top:1px solid GrayText;padding-block:12px}summary{cursor:pointer;min-height:44px;display:list-item}article,.notice{padding:16px;border:1px solid GrayText;border-radius:16px;margin-block:12px;overflow-wrap:anywhere}.muted{opacity:.75;font-size:.9rem}.actions{display:flex;gap:8px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:24px}.project-button{display:block;width:100%;text-align:start;margin-bottom:8px}.selected{outline:2px solid Highlight}progress{width:100%;height:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.ltr{direction:ltr;text-align:left}button:disabled{opacity:.5;cursor:wait}:focus-visible{outline:3px solid Highlight;outline-offset:3px}[hidden]{display:none!important}@media(max-width:700px){.grid{grid-template-columns:minmax(0,1fr)}header,main{padding:12px}}
</style></head><body><header><a href="/">بازگشت به چت</a><h1>اهداف و پروژه‌ها</h1><button id="refresh">به‌روزرسانی</button></header>
<main><p class="notice muted">این برد از چت و دپارتمان‌های اصلی جداست. پذیرفتن کار، اجرای آن نیست؛ نقش مدیر مجوز ابزار یا تأیید امنیتی بات را تغییر نمی‌دهد.</p><p id="status" role="status" aria-live="polite">در حال دریافت…</p><div class="grid"><aside aria-label="فهرست پروژه‌ها"><div id="projects"></div><details><summary>پروژهٔ جدید</summary><form id="new-project"><label>نام<input name="name" required maxlength="80"></label><label>هدف<textarea name="goal" maxlength="400"></textarea></label><button>ساخت پروژه</button></form></details></aside><section id="detail" aria-label="جزئیات پروژه"></section></div></main>
<script>
(() => {
  let state, selected = new URL(location.href).searchParams.get('project');
  const status = document.querySelector('#status'), list = document.querySelector('#projects'), detail = document.querySelector('#detail');
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const message = (text, error = false) => { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Error(response.status === 403 ? 'مدیریت این برد به حساب مالک یا مدیر نیاز دارد.' : data.error || 'درخواست انجام نشد.');
    return data;
  };
  const mutate = async (button, path, method, body) => { button.disabled = true; try { await api(path, method, body); await load(); message('ذخیره شد.'); } catch (error) { message(error.message, true); } finally { button.disabled = false; } };
  const action = (label, parent, path, method, body) => { const button = node('button', label); button.type = 'button'; button.addEventListener('click', () => mutate(button, path, method, body)); parent.append(button); return button; };
  const botName = id => state.bots.find(bot => bot.id === id)?.name || id || 'تعیین نشده';
  const field = (form, title, name, value = '', type = 'text') => { const label = node('label', title), input = node(type === 'textarea' ? 'textarea' : 'input'); input.name = name; input.value = value; if (type !== 'textarea') input.type = type; label.append(input); form.append(label); return input; };
  const select = (form, title, name, options, value) => { const label = node('label', title), input = node('select'); input.name = name; for (const [id, text] of options) { const option = node('option', text); option.value = id; input.append(option); } input.value = value || ''; label.append(input); form.append(label); return input; };
  const form = (parent, title, path, method, build, body) => {
    const box = node('details'), heading = node('summary', title), el = node('form'), button = node('button', 'ذخیره');
    box.append(heading, el); parent.append(box); build(el); el.append(button);
    el.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(el)); await mutate(button, path, method, body ? body(values) : values); });
  };
  const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const render = () => {
    list.replaceChildren(); detail.replaceChildren();
    for (const project of state.projects) { const button = node('button', project.name, 'project-button' + (project.id === selected ? ' selected' : '')); button.addEventListener('click', () => { selected = project.id; history.replaceState(null, '', '/company?project=' + encodeURIComponent(selected)); render(); }); list.append(button); }
    const project = state.projects.find(item => item.id === selected) || state.projects[0];
    if (!project) { detail.append(node('p', 'هنوز پروژه‌ای ندارید. از «پروژهٔ جدید» شروع کنید.')); return; }
    selected = project.id; const root = '/api/company/projects/' + encodeURIComponent(project.id);
    detail.append(node('h2', project.name), node('p', project.goal || 'هدف هنوز نوشته نشده است.'));
    const progress = node('progress'); progress.max = 100; progress.value = project.progress?.percent || 0; progress.setAttribute('aria-label', 'پیشرفت تأییدشده'); detail.append(progress, node('p', (project.progress?.verified || 0) + ' از ' + (project.progress?.total || 0) + ' کار پذیرفته‌شده، تأیید نهایی دارد.', 'muted'));
    form(detail, 'تنظیم هدف و شیوه', root, 'PATCH', el => { field(el, 'نام', 'name', project.name).required = true; field(el, 'هدف', 'goal', project.goal, 'textarea'); select(el, 'شیوهٔ هماهنگی در دستور مدل', 'style', [['hierarchy','سلسله‌مراتبی'],['flat','تخت'],['lanes','ستونی']], project.style); select(el, 'مدیر', 'chiefBotId', [['','بدون مدیر'], ...project.members.map(member => [member.botId, botName(member.botId)])], project.chiefBotId); });
    detail.append(node('h3', 'کارها'));
    for (const task of project.tasks) {
      const card = node('article'); card.append(node('strong', task.title), node('p', 'مسئول: ' + botName(task.assigneeBotId) + ' · ' + ({proposed:'پیشنهاد',open:'در حال انجام',done:'انجام‌شده',rejected:'ردشده'}[task.status] || task.status) + ' · ' + task.percent + '٪', 'muted'));
      if (task.result) card.append(node('p', task.result));
      if (task.blockedKind) card.append(node('p', 'مانع: ' + task.blockedKind));
      const controls = node('div', undefined, 'actions'); card.append(controls);
      if (task.status === 'proposed') { action('پذیرش', controls, root + '/tasks/' + task.id + '/accept', 'POST', {accept:true}); action('رد', controls, root + '/tasks/' + task.id + '/accept', 'POST', {accept:false}); }
      if (task.status === 'open' || task.status === 'done') form(card, 'گزارش پیشرفت', root + '/tasks/' + task.id, 'PATCH', el => { select(el, 'وضعیت', 'status', [['open','در حال انجام'],['done','انجام‌شده']], task.status); const percent = field(el, 'درصد', 'percent', task.percent, 'number'); percent.min = 0; percent.max = 100; field(el, 'نتیجه و شاهد انجام کار', 'result', task.result || '', 'textarea'); }, value => ({...value, percent:Number(value.percent)}));
      if (task.status === 'done' && !task.verified) action('تأیید نتیجه', controls, root + '/tasks/' + task.id + '/verify', 'POST', {verified:true});
      if (task.verified) controls.append(node('span', 'نتیجه تأیید شده است.'));
      detail.append(card);
    }
    form(detail, 'پیشنهاد کار', root + '/tasks', 'POST', el => { field(el, 'عنوان کار', 'title').required = true; select(el, 'مسئول', 'assigneeBotId', [['','تعیین نشده'],...project.members.map(member => [member.botId,botName(member.botId)])]); });
    detail.append(node('h3', 'حافظهٔ پروژه'));
    for (const item of project.memory) { const card = node('article'); card.append(node('p', item.text), node('small', {proposed:'منتظر تأیید',approved:'تأییدشده',rejected:'ردشده'}[item.status])); if (item.status === 'proposed') { const controls = node('div', undefined, 'actions'); action('تأیید', controls, root + '/memory/' + item.id, 'POST', {approve:true}); action('رد', controls, root + '/memory/' + item.id, 'POST', {approve:false}); card.append(controls); } detail.append(card); }
    form(detail, 'پیشنهاد حافظه', root + '/memory', 'POST', el => { field(el, 'متن', 'text', '', 'textarea').required = true; }, value => ({...value, by:'user'}));
    form(detail, 'اعضا و نقش‌ها', root + '/members', 'POST', el => { el.append(node('p', project.members.map(member => botName(member.botId) + ' — ' + member.role).join('، ') || 'هنوز عضوی ثبت نشده است.')); select(el, 'بات', 'botId', state.bots.map(bot => [bot.id,bot.name])); field(el, 'نقش', 'role'); field(el, 'ستون', 'lane'); });
    form(detail, 'فایل‌های پروژه', root, 'PATCH', el => { field(el, 'مسیرهای مجاز روی سرور، هر مسیر در یک خط (حداکثر ۳)', 'files', project.files.join('\n'), 'textarea'); el.append(node('p', 'این قسمت فایل آپلود نمی‌کند. فقط فایل‌های مجاز و موجود خوانده می‌شوند؛ PDF و تصویر در این مسیر استخراج متن ندارند.', 'muted')); }, value => ({files:lines(value.files)}));
    form(detail, 'پیوند گفتگو', root + '/chats', 'POST', el => { select(el, 'بات عضو', 'botId', project.members.map(member => [member.botId,botName(member.botId)])); field(el, 'شناسهٔ گفتگو', 'threadId').required = true; el.append(node('p', project.chats.map(chat => botName(chat.botId) + ': ' + chat.threadId).join('\n'), 'muted')); });
    const saved = node('details'); saved.append(node('summary', 'یادداشت و خلاصهٔ گفتگو')); detail.append(saved);
    const chooser = node('select'); const placeholder = node('option', 'یک گفتگوی پیوندشده را انتخاب کنید'); placeholder.value = ''; chooser.append(placeholder);
    for (const chat of project.chats) { const option = node('option', botName(chat.botId) + ' · ' + chat.threadId.slice(0,8)); option.value = chat.threadId; chooser.append(option); } chooser.setAttribute('aria-label','گفتگو'); saved.append(chooser); const editor = node('div'); saved.append(editor);
    chooser.addEventListener('change', () => { editor.replaceChildren(); const id = chooser.value; if (!id) return; const thread = state.threads[id] || {};
      form(editor, 'ویرایش حافظهٔ همین گفتگو', '/api/company/threads/' + encodeURIComponent(id), 'PUT', el => { field(el,'یادداشت','notes',thread.notes || '', 'textarea'); for (const [key,title] of [['decisions','تصمیم‌ها'],['facts','واقعیت‌ها'],['tasks','کارهای باقی‌مانده'],['preferences','ترجیحات']]) field(el,title,key,thread.summary?.[key] || '', 'textarea'); field(el,'شناسهٔ پیام‌های مهم، هر شناسه در یک خط','important',(thread.important || []).join('\n'),'textarea'); field(el,'مسیر فایل‌های همین گفتگو','files',(thread.files || []).join('\n'),'textarea'); }, value => ({notes:value.notes, summary:{decisions:value.decisions,facts:value.facts,tasks:value.tasks,preferences:value.preferences}, important:lines(value.important), files:lines(value.files)}));
    });
  };
  async function load() { try { state = await api('/api/company'); render(); message('اطلاعات به‌روز است.'); } catch (error) { message(error.message, true); } }
  document.querySelector('#refresh').addEventListener('click', load);
  document.querySelector('#new-project').addEventListener('submit', async event => { event.preventDefault(); const el = event.currentTarget, button = el.querySelector('button'); button.disabled = true; try { const project = await api('/api/company/projects','POST',Object.fromEntries(new FormData(el))); selected = project.id; await load(); el.reset(); } catch (error) { message(error.message,true); } finally { button.disabled = false; } });
  load();
})();
</script></body></html>`;
