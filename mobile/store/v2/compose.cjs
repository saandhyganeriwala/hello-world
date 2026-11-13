// App Store screenshots v2: each one shows a transformation, built from real UI captures (ui-captures/*.png).
// Sizes: iPhone 1206×2622, iPhone Duo 2007×2853, iPad 13" 2064×2752.
const { chromium } = require('playwright'); const fs = require('fs');
const D = __dirname, OUT = __dirname + '/';
const img = n => 'data:image/png;base64,' + fs.readFileSync(D + '/ui-captures/' + n + '.png').toString('base64');
const inner = fs.readFileSync(D + '/ui-captures/ele-inner.svg', 'utf8');
const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Hanken+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;600&display=swap">';
const SIZES = { iphone: [1206, 2622], duo: [2007, 2853], ipad: [2064, 2752] };

const arrow = (dir) => `<div class="arrow ${dir}"><svg viewBox="0 0 24 24" fill="none" stroke="#141414" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${dir === 'down' ? '<path d="M12 5v14M6 13l6 6 6-6"/>' : '<path d="M5 12h14M13 6l6 6-6 6"/>'}</svg></div>`;
const tag = (t) => `<div class="tag">${t}</div>`;
const voice = `<div class="voice"><span class="mic"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>
  <span class="bars">${[6,14,22,12,26,18,9,20,28,15,8,19,24,11,17,7,13,21,10,16].map(h => `<i style="height:calc(var(--u)*${h * 2.2})"></i>`).join('')}</span><span class="t">0:07</span></div>`;

const SHOTS = [
  { key: '1-message', kicker: 'Record by message', title: 'Stop typing into <mark>spreadsheets.</mark>', sub: 'Just send a message. CRUD.chat turns it into a record.',
    demo: (wide) => `<div class="flow ${wide ? 'row' : 'col'}"><div class="step">${tag('You type')}<img class="ui w-msg" src="${img('msg-kashish')}"></div>${arrow(wide ? 'right' : 'down')}<div class="step">${tag('It becomes an order')}<img class="ui w-card" src="${img('card-kashish')}"></div></div>` },
  { key: '2-voice', kicker: 'Voice notes', title: 'Say it. <mark>It’s recorded.</mark>', sub: 'Talk in English or Hinglish. Orders, payments and tasks fill themselves in.',
    demo: (wide) => `<div class="flow ${wide ? 'row' : 'col'}"><div class="step">${tag('You speak')}${voice}</div>${arrow(wide ? 'right' : 'down')}<div class="step">${tag('It’s written and filed')}<img class="ui w-msg" src="${img('msg-hinglish')}"></div></div>` },
  { key: '3-screenshot', kicker: 'Screenshots', title: 'Snap a screenshot. <mark>It’s filed.</mark>', sub: 'Customer chats and bills are read and turned into orders.',
    demo: (wide) => `<div class="flow ${wide ? 'row' : 'col'}"><div class="step">${tag('You share a screenshot')}<img class="ui w-shot" src="${img('msg-screenshot')}"></div>${arrow(wide ? 'right' : 'down')}<div class="step">${tag('The order is ready')}<img class="ui w-card" src="${img('card-ananya')}"></div></div>` },
  { key: '4-ask', kicker: 'Answers', title: 'Ask. <mark>Get the answer.</mark>', sub: 'No formulas. Every question is answered from your own records.',
    demo: () => `<div class="flow col chat"><img class="ui w-msg right" src="${img('msg-question')}"><img class="ui w-msg left" src="${img('msg-answer')}">${tag('From this order')}<img class="ui rec" src="${img('card-orchid')}"></div>` },
  { key: '5-views', kicker: 'Views', title: 'The app <mark>builds itself.</mark>', sub: 'Pipelines, dashboards and ledgers appear as you go. Just ask for any view.',
    demo: (wide) => `<div class="flow col"><img class="ui w-ask right" src="${img('msg-pipeline-ask')}">${arrow('down')}<img class="ui w-board" src="${img('view-pipeline')}"><div class="pair ${wide ? 'row' : 'col'}"><img class="ui w-tile" src="${img('view-overview')}">${wide ? `<img class="ui w-tile" src="${img('view-ledger')}">` : ''}</div></div>` },
  { key: '6-team', kicker: 'Teams', title: 'One live record for <mark>the whole team.</mark>', sub: 'Everyone records from their phone. Everyone sees it instantly.',
    demo: (wide) => `<div class="team ${wide ? 'row' : 'col'}"><div class="phone"><img src="${img('screen-orders')}"></div>${wide ? `<div class="float col"><img class="ui w-msg" src="${img('msg-hinglish')}"><img class="ui w-msg" src="${img('msg-kashish')}"></div>` : `<img class="ui w-msg floaty" src="${img('msg-hinglish')}">`}</div>` },
];

function page(W, H, s) {
  const wide = false; // one tall layout, scaled to fit, for every device
  const roomy = W / H > 0.6; // Duo / iPad: bigger type, a little more scale
  const u = Math.min(W / 1206, H / (roomy ? 2420 : 2622)); // 1 design px
  return `<html><head>${FONTS}<style>
  *{margin:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;--u:${u}px;background:#F4F2EC;color:#141414;font-family:"Hanken Grotesk",sans-serif;
    background-image:radial-gradient(circle at 85% 8%,rgba(255,195,31,.28),transparent 32%),radial-gradient(circle at 8% 92%,rgba(14,138,138,.10),transparent 30%),
      linear-gradient(rgba(20,20,20,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(20,20,20,.045) 1px,transparent 1px);
    background-size:auto,auto,calc(var(--u)*56) calc(var(--u)*56),calc(var(--u)*56) calc(var(--u)*56)}
  .top{flex:none;padding-top:calc(var(--u)*${roomy ? 110 : 150}) !important;text-align:center;padding:0 calc(var(--u)*70)}
  .brand{display:inline-flex;align-items:center;gap:calc(var(--u)*14);font-family:"Bricolage Grotesque";font-weight:800;font-size:calc(var(--u)*38);margin-bottom:calc(var(--u)*34)}
  .brand svg{width:calc(var(--u)*58);height:calc(var(--u)*58)}
  .brand b{color:#8A6400}
  .kicker{font-family:"JetBrains Mono";font-weight:600;font-size:calc(var(--u)*28);letter-spacing:.14em;text-transform:uppercase;color:#0E8A8A;margin-bottom:calc(var(--u)*22)}
  h1{font-family:"Bricolage Grotesque";font-weight:800;letter-spacing:-.035em;line-height:1.0;font-size:calc(var(--u)*${roomy ? 140 : 126});text-wrap:balance}
  mark{background:#FFC31F;color:inherit;padding:0 .08em;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  .sub{font-size:calc(var(--u)*44);line-height:1.38;color:#46433D;margin:calc(var(--u)*30) auto 0;max-width:calc(var(--u)*${roomy ? 1400 : 980})}
  .demo{flex:1;min-height:0;position:relative;margin:calc(var(--u)*70) 0 calc(var(--u)*${roomy ? 60 : 100});display:flex;justify-content:center;align-items:center;padding:0 calc(var(--u)*50)}
  .flow{display:flex;align-items:center;gap:calc(var(--u)*56)}
  .flow.col{flex-direction:column}
  .flow.row{flex-direction:row;align-items:center;gap:calc(var(--u)*50)}
  .step{display:flex;flex-direction:column;align-items:center;gap:calc(var(--u)*20)}
  .tag{font-family:"JetBrains Mono";font-weight:600;font-size:calc(var(--u)*28);letter-spacing:.1em;text-transform:uppercase;color:#85817A}
  .ui{display:block;filter:drop-shadow(0 calc(var(--u)*26) calc(var(--u)*40) rgba(20,20,20,.16));border-radius:calc(var(--u)*30)}
  .w-msg{width:calc(var(--u)*1080)} .w-card{width:calc(var(--u)*1090)} .w-shot{width:calc(var(--u)*700)} .w-ask{width:calc(var(--u)*900)}
  .w-board{width:calc(var(--u)*1110);background:#F4F2EC;border-radius:calc(var(--u)*30);padding:calc(var(--u)*14)}
  .w-tile{width:calc(var(--u)*900)}
  .flow.row .w-msg{width:calc(var(--u)*820)} .flow.row .w-card{width:calc(var(--u)*840)} .flow.row .w-shot{width:calc(var(--u)*620)}
  .chat{gap:calc(var(--u)*44);align-items:stretch;width:calc(var(--u)*1100)} .chat .right{align-self:flex-end;width:calc(var(--u)*960)} .chat .left{align-self:flex-start;width:calc(var(--u)*1080)} .chat .rec{align-self:center;width:calc(var(--u)*1000);margin-top:calc(var(--u)*10)}
  .flow.col .right{align-self:flex-end}
  .pair{display:flex;gap:calc(var(--u)*30);margin-top:calc(var(--u)*30)} .pair.col{flex-direction:column}
  .arrow{width:calc(var(--u)*110);height:calc(var(--u)*110);border-radius:50%;background:#FFC31F;border:calc(var(--u)*4) solid #141414;display:grid;place-items:center;box-shadow:0 calc(var(--u)*6) 0 #141414;flex:none}
  .arrow svg{width:calc(var(--u)*54);height:calc(var(--u)*54)}
  .voice{zoom:1.35;display:flex;align-items:center;gap:calc(var(--u)*26);background:#FFFEFA;border:calc(var(--u)*3) solid #E0DBCF;border-radius:999px;padding:calc(var(--u)*22) calc(var(--u)*40) calc(var(--u)*22) calc(var(--u)*22);box-shadow:0 calc(var(--u)*26) calc(var(--u)*40) rgba(20,20,20,.14)}
  .voice .mic{width:calc(var(--u)*96);height:calc(var(--u)*96);border-radius:50%;background:#D23A2E;display:grid;place-items:center;box-shadow:0 0 0 calc(var(--u)*14) rgba(210,58,46,.18)}
  .voice .mic svg{width:calc(var(--u)*46);height:calc(var(--u)*46)}
  .voice .bars{display:flex;align-items:center;gap:calc(var(--u)*9)} .voice .bars i{display:block;width:calc(var(--u)*9);border-radius:99px;background:#D23A2E}
  .voice .t{font-family:"JetBrains Mono";font-weight:600;font-size:calc(var(--u)*34);color:#46433D}
  .team{display:flex;gap:calc(var(--u)*50);align-items:flex-start} .team.col{flex-direction:column;align-items:center;position:relative}
  .phone{width:calc(var(--u)*${wide ? 800 : 980});border:calc(var(--u)*22) solid #141414;border-bottom:0;border-radius:calc(var(--u)*110) calc(var(--u)*110) 0 0;overflow:hidden;background:#141414;box-shadow:0 calc(var(--u)*50) calc(var(--u)*90) rgba(20,20,20,.35)}
  .phone img{display:block;width:100%;border-radius:calc(var(--u)*88) calc(var(--u)*88) 0 0}
  .float{display:flex;flex-direction:column;gap:calc(var(--u)*40);margin-top:calc(var(--u)*240)} .float .w-msg{width:calc(var(--u)*760)}
  .floaty{position:absolute;top:calc(var(--u)*640);right:calc(var(--u)*-70);width:calc(var(--u)*860);transform:rotate(-2deg)}
  </style></head><body>
  <div class="top"><div class="brand"><svg viewBox="0 0 512 512"><rect x="12" y="12" width="488" height="488" rx="124" fill="#FFC31F" stroke="#141414" stroke-width="22"/><g transform="translate(256 258) scale(5.2) translate(-32 -32)">${inner}</g></svg><span>CRUD<b>.chat</b></span></div>
    <div class="kicker">${s.kicker}</div><h1>${s.title}</h1><p class="sub">${s.sub}</p></div>
  <div class="demo">${s.demo(wide)}</div></body></html>`;
}

(async () => {
  const b = await chromium.launch();
  for (const [dev, [W, H]] of Object.entries(SIZES)) {
    fs.mkdirSync(OUT + dev, { recursive: true });
    for (const s of SHOTS) {
      const p = await b.newPage({ viewport: { width: W, height: H } });
      await p.setContent(page(W, H, s), { waitUntil: 'networkidle' }); await p.waitForTimeout(250);
      // shrink the demo if it doesn't fit its box (team shot is allowed to run off the bottom)
      await p.evaluate((team) => { const d = document.querySelector('.demo'), c = d.firstElementChild; if (team) { d.style.alignItems = 'flex-start'; return; }
        const k = Math.min(1, d.clientHeight / c.scrollHeight, (d.clientWidth - 20) / c.scrollWidth); if (k < 1) { c.style.transform = `scale(${k})`; } }, s.key === '6-team');
      await p.waitForTimeout(100);
      await p.screenshot({ path: `${OUT}${dev}/${s.key}.png` }); await p.close();
    }
  }
  await b.close(); console.log('composed');
})();
