/* 빌드 버전이 바뀌면 옛 서비스워커/캐시를 한 번 지우고 새로고침한다(옛 JS와 새 JS가 섞여 빈 화면이 되는 것 방지). */
(function(){try{var B='2026-10-10-c';if(localStorage.getItem('gnmap_v2_build')===B)return;localStorage.setItem('gnmap_v2_build',B);
var p=[];if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){p.push(navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}));}
if(window.caches&&caches.keys){p.push(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}));}
if(p.length)Promise.all(p).then(function(){location.reload();}).catch(function(){});}catch(e){}})();
