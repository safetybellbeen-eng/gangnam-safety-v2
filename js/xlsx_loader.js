// 엑셀 라이브러리(SheetJS, 약 0.86MB)를 "엑셀 내보내기/업로드를 실제로 쓸 때" 처음 한 번만 불러온다.
// 앱 시작 때는 받지 않으므로 첫 화면 로딩이 가벼워진다. 이미 불러왔다면 즉시 반환한다.
let loading = null;
export function ensureXlsx() {
  if (window.XLSX && window.XLSX.utils) return Promise.resolve(window.XLSX);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => {
      if (window.XLSX && window.XLSX.utils) resolve(window.XLSX);
      else { loading = null; reject(new Error('XLSX 로드 실패')); }
    };
    s.onerror = () => { loading = null; reject(new Error('XLSX 로드 실패')); };
    document.head.appendChild(s);
  });
  return loading;
}
