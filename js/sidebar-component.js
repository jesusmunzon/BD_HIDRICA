(function(){
  'use strict';
  const path=location.pathname.replace(/\\/g,'/');
  const sub=/\/(?:Estadisticos[234]|base-datos|tablas_auxiliares)\//i.test(path);
  const root=sub?'../':'';
  const active=/\/base-datos\//i.test(path)?'base-datos':/\/tablas_auxiliares\//i.test(path)?'tablas-auxiliares':/\/Estadisticos2\//i.test(path)?'estadisticos2':/\/Estadisticos3\//i.test(path)?'estadisticos3':/\/Estadisticos4\//i.test(path)?'estadisticos4':'estadisticos1';
  const items=[['estadisticos1',`${root}index.html`,'layout-dashboard','Estadísticos 1'],['estadisticos2',`${root}Estadisticos2/index.html`,'bar-chart-3','Estadísticos 2'],['estadisticos3',`${root}Estadisticos3/index.html`,'user','Estadísticos 3'],['estadisticos4',`${root}Estadisticos4/index.html`,'trending-up','Estadísticos 4']];
  const host=document.getElementById('sidebar-component'); if(!host)return;
  host.innerHTML=`<aside class="sidebar" id="sidebar"><header class="brand"><div class="brand-icon"><img src="${root}logo.svg" alt="Logo Control de Red"></div><div><strong>Control de Red</strong><span>Analítica hidráulica</span></div><button aria-label="Cerrar menú" class="icon-button mobile-only" id="closeMenu" type="button"><i data-lucide="x"></i></button></header><nav class="nav"><p class="nav-title">Menú principal</p>${items.map(i=>`<a class="nav-item${i[0]===active?' active':''}" href="${i[1]}"><i data-lucide="${i[2]}"></i><span>${i[3]}</span></a>`).join('')}<p class="nav-title second">Ajustes y sistema</p><a class="nav-item${active==='base-datos'?' active':''}" href="${root}base-datos/index.html"><i data-lucide="database"></i><span>Base de datos</span></a><a class="nav-item${active==='tablas-auxiliares'?' active':''}" href="${root}tablas_auxiliares/index.html"><i data-lucide="table-2"></i><span>Tablas auxiliares</span></a></nav><footer class="sidebar-footer"><div class="status-icon"><i data-lucide="circle-user-round"></i><b></b></div><div><strong id="sidebarUserName">Invitado</strong><span id="sidebarUserMode">Modo Lectura</span></div></footer></aside>`;
  const sidebar=document.getElementById('sidebar'),overlay=document.getElementById('overlay');
  const close=()=>{sidebar?.classList.remove('open');overlay?.classList.remove('open')};
  document.getElementById('openMenu')?.addEventListener('click',()=>{sidebar?.classList.add('open');overlay?.classList.add('open')});
  document.getElementById('closeMenu')?.addEventListener('click',close);overlay?.addEventListener('click',close);
  function theme(value){const dark=value==='dark';document.body.classList.toggle('dark',dark);document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('control-red-theme',dark?'dark':'light');document.getElementById('themeIcon')?.setAttribute('data-lucide',dark?'sun':'moon');window.lucide?.createIcons()}
  theme(localStorage.getItem('control-red-theme')==='dark'?'dark':'light');
  
  function permissions(session){const admin=Boolean(session?.administrator);document.body.dataset.accessMode=admin?'edit':'read';document.querySelectorAll('#addRow,#addAuxRecord,#addAuxRecordForm button[type=submit],#saveExcel,#addChgLookup,#addChgInfo,#confirmEdit,#confirmChgAux,.iconAction.edit,.iconAction.delete,.chgAuxAction,#auxTable .editable-cell input,#auxTable .editable-cell select').forEach(el=>{el.disabled=!admin;el.classList.toggle('permission-disabled',!admin);el.setAttribute('aria-disabled',String(!admin))})}
  window.addEventListener('control-red-auth-change',e=>permissions(e.detail));
  document.addEventListener('DOMContentLoaded',()=>permissions(window.AuthSession?.get?.()||{administrator:false}),{once:true});
  window.lucide?.createIcons();
})();
