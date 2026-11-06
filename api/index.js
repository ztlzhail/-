// Vercel 서버리스 함수 — 모든 /api/* 요청이 vercel.json 의 rewrite 로 여기에 온다.
const { handler } = require('../lib/app');
module.exports = handler;
