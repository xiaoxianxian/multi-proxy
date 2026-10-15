/* multi-proxy design-system · shared micro-behavior + unified shell injector
   - 注入统一侧栏（修 nav 3→13 漂移：全 8 页同一套导航）
   - 主题切换（暗色默认，localStorage 持久）
   - 动态 toast
   用法: 页面里放 <aside class="sidebar" data-shell data-active="dashboard"></aside>，
        本页对应文件名（不带 .html）即 active。零依赖。                                   */
(function () {
  'use strict';
  var root = document.documentElement;

  /* ---- theme ---- */
  function stored(){ try{ return localStorage.getItem('mp-theme'); }catch(e){ return null; } }
  function apply(t){ root.setAttribute('data-theme', t); }
  apply(stored() || 'dark');

  /* ---- icon set (18px stroke) ---- */
  var I = {
    grid:   '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    list:   '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
    term:   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    slider: '<path d="M4 8h9M19 8h1M4 16h1M11 16h9"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
    book:   '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 17.5z"/><path d="M4 17.5V4.5M8 6h8M8 10h6"/>',
    spark:  '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5 9 9M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
    refresh:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    moon:   '<path d="M20 14a8 8 0 1 1-9-9 6 6 0 0 0 9 9z"/>',
    sun:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    out:    '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    link:   'data-upd'
  };
  function svg(inner, w){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" '+(w||'')+'>'+inner+'</svg>'; }

  /* ---- canonical nav（全 8 页一致） ---- */
  var NAV = [
    { label:'运行', items:[
      { id:'dashboard',    name:'概览',   ic:I.grid,   badge:'' },
      { id:'floor',        name:'代理面', ic:I.layers, badge:'5' },
      { id:'sessions',     name:'任务',   ic:I.list,   badge:'3' },
      { id:'logs',         name:'日志',   ic:I.term,   badge:'' },
    ]},
    { label:'配置', items:[
      { id:'proxy-config', name:'代理配置', ic:I.slider, badge:'' },
      { id:'knowledge',    name:'知识库',   ic:I.book,   badge:'' },
      { id:'skills',       name:'技能',     ic:I.spark,  badge:'' },
    ]}
  ];

  function buildShell(activeId){
    var nav = NAV.map(function(sec){
      var items = sec.items.map(function(it){
        var cls = 'nav-item' + (it.id===activeId ? ' active':'');
        var hd = '<span class="ic">'+svg(it.ic)+'</span>'+it.name+
                 (it.badge ? '<span class="badge">'+it.badge+'</span>':'');
        return '<a class="'+cls+'" data-href="'+it.id+'">'+hd+'</a>';
      }).join('');
      return '<div class="nav-label">'+sec.label+'</div>'+items;
    }).join('');
    return ''+
      '<div class="brand"><div class="mark">P</div><div><h1>multi-proxy</h1>'+
      '<div class="sub">Manager · v1.0.0</div></div></div>'+
      '<nav class="nav">'+nav+'</nav>'+
      '<div class="sidebar-foot">'+
        '<div class="row"><span class="mono">v1.0.0</span>'+
          '<a class="btn btn-sm btn-ghost" data-upd onclick="mpCheckUpdate()">'+svg(I.refresh)+'检查更新</a></div>'+
        '<div class="row">'+
          '<button class="btn btn-sm btn-ghost" data-toggle-theme>'+svg(I.moon)+'暗色</button>'+
          '<button class="btn btn-sm btn-ghost" onclick="mpToast(\'已登出\',\'info\')">'+svg(I.out)+'登出</button></div>'+
      '</div>';
  }

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('[data-shell]').forEach(function(el){
      var act = el.getAttribute('data-active') || '';
      el.innerHTML = buildShell(act);
      // nav 跳转（同目录 mockup 文件）
      el.querySelectorAll('[data-href]').forEach(function(a){
        a.addEventListener('click', function(e){
          e.preventDefault();
          var h = a.getAttribute('data-href');
          if (h === act) return;
          location.href = h + '.html';
        });
      });
    });
  });

  /* ---- theme toggle ---- */
  document.addEventListener('click', function(e){
    var t = e.target.closest('[data-toggle-theme]');
    if(!t) return;
    var next = root.getAttribute('data-theme')==='dark' ? 'light':'dark';
    apply(next);
    try{ localStorage.setItem('mp-theme', next); }catch(e){}
    t.innerHTML = svg(next==='dark'?I.moon:I.sun) + (next==='dark'?'暗色':'亮色');
  });

  /* ---- toast ---- */
  window.mpToast = function(msg, type){
    type = type || 'info';
    var host = document.querySelector('.toasts');
    if(!host){ host = document.createElement('div'); host.className='toasts'; document.body.appendChild(host); }
    var el = document.createElement('div');
    el.className = 'toast '+type;
    var ic = {success:'M8.5 12.5 11 15l4.5-5', error:'M12 8v5M12 16h.01',
              warning:'M12 9v5M12 17h.01', info:'M12 11v5M12 8h.01'}[type];
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/>'+(ic?'<path d="'+ic+'"/>':'')+'</svg><span></span>';
    el.querySelector('span').textContent = msg;
    host.appendChild(el);
    setTimeout(function(){ el.style.transition='opacity .3s, transform .3s'; el.style.opacity='0'; el.style.transform='translateX(20px)'; setTimeout(function(){el.remove();},320); }, 3000);
  };

  /* ---- 检查更新（更新源 sifking manifest 待发布：先诚实占位，不假跳 404） ---- */
  window.mpCheckUpdate = function(){ window.mpToast('应用内更新：更新源待发布', 'info'); };
})();
