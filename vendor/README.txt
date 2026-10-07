외부 CDN(jsdelivr) 대신 직접 호스팅하는 라이브러리(공급망 공격 방지).
- supabase.min.js : @supabase/supabase-js 2.117.2 (dist/umd/supabase.js)
- xlsx.full.min.js: xlsx 0.18.5 (dist/xlsx.full.min.js)
버전을 올릴 때는 npm에서 받아 이 폴더 파일을 교체하고, sw.js CACHE_VERSION을 올린다.
