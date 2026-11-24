// Money split check. Run: node calc.check.js public/index.html
const num = v => { const n = parseFloat(String(v ?? '').replace(/\s/g,'').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const sum = xs => xs.reduce((a, b) => a + b, 0);
const src = require('fs').readFileSync(process.argv[2], 'utf8');
eval(src.match(/const wstate[^\n]*\n/)[0] + src.match(/function calc\(c\) \{[\s\S]*?\n\}/)[0] + ';globalThis.calc=calc');
const a = require('assert');
// KYMA-like: done 1800, paid 900, doing 300, planned 2500
let m = calc({works:[{amount:1800,state:'done'},{amount:300,state:'doing'},{amount:2500,state:'planned'}],payments:[{amount:900}]});
a.deepStrictEqual([m.owed,m.inWork,m.plan],[900,300,2500]);
// advance bigger than done eats into in-progress first, then planned
m = calc({works:[{amount:100,done:true},{amount:500,state:'doing'},{amount:400}],payments:[{amount:700}]});
a.deepStrictEqual([m.owed,m.inWork,m.plan],[0,0,300]);
// legacy boolean still works
m = calc({works:[{amount:1000,done:true},{amount:200,done:false}],payments:[]});
a.deepStrictEqual([m.owed,m.inWork,m.plan],[1000,0,200]);
console.log('calc ok');
