// extract.js
// Usage: node extract.js <file.js|file.json> [--verbose]
// Requires: acorn (npm i acorn)

const fs = require('fs');
const acorn = require('acorn');

if (process.argv.length < 3) {
  console.error("Usage: node extract.js <file.js|file.json> [--verbose]");
  process.exit(1);
}
const path = process.argv[2];
const verbose = process.argv.includes('--verbose');

let raw;
try { raw = fs.readFileSync(path, 'utf8'); } catch (e) { console.error("Read error:", e.message); process.exit(1); }

let ast = null;
function parseJsToAst(code) {
  try { return acorn.parse(code, { ecmaVersion: 2020, sourceType: 'module', locations: true }); }
  catch (e) { console.error("Parse error (JS):", e.message); process.exit(1); }
}

// Accept AST JSON or raw JS
try {
  const j = JSON.parse(raw);
  ast = (j && typeof j === 'object' && j.type === 'Program') ? j : parseJsToAst(raw);
} catch { ast = parseJsToAst(raw); }

// ---- tiny walker
function walkFull(node, cb, parent = null) {
  if (!node || typeof node !== 'object') return;
  cb(node, parent);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) for (const el of v) walkFull(el, cb, node);
    else if (v && typeof v === 'object' && v.type) walkFull(v, cb, node);
  }
}

// ---- helpers
const isNumLit = n => n && n.type === 'Literal' && typeof n.value === 'number';
const isNumArray = n => n && n.type === 'ArrayExpression' && n.elements?.length > 0 &&
  n.elements.every(e => e && e.type === 'Literal' && typeof e.value === 'number');
const locStr = loc => loc ? `${loc.start.line}:${loc.start.column}` : '?';
const printable = s => String(s).replace(/[\x00-\x1F\x7F]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2,'0')}`);

// ---- collect var inits
const varDecls = new Map();
walkFull(ast, (node) => {
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
    varDecls.set(node.id.name, node.init);
  }
});

// ---- infer keys from concat + compound assigns
const inferredKeys = {};
function evalConcatToString(node){
  if (!node) return null;
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'ArrayExpression' && node.elements.length === 1 && isNumLit(node.elements[0])) {
    return String(node.elements[0].value);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const L = evalConcatToString(node.left);
    const R = evalConcatToString(node.right);
    if (L != null && R != null) return L + R;
  }
  return null;
}
walkFull(ast, (node) => {
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
    const s = evalConcatToString(node.init);
    if (s != null) inferredKeys[node.id.name] = { type:'concat_string', value: s, loc: node.loc };
    else if (isNumLit(node.init)) inferredKeys[node.id.name] = { type:'numeric', value: node.init.value, loc: node.loc };
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier'
      && ['>>=','<<=','^='].includes(node.operator) && isNumLit(node.right)) {
    const name = node.left.name; const op = node.operator; const n = node.right.value;
    const prev = inferredKeys[name];
    if (prev && prev.type === 'concat_string') {
      try {
        const asNum = BigInt(prev.value);
        let after;
        if (op === '>>=') after = Number(asNum >> BigInt(n));
        else if (op === '<<=') after = Number(asNum << BigInt(n));
        else if (op === '^=') after = Number(asNum ^ BigInt(n));
        inferredKeys[name] = { type:'numeric', value: after, origin: prev.value, loc: node.loc, op, opArg: n };
      } catch {}
    } else if (prev && prev.type === 'numeric') {
      let after = prev.value;
      if (op === '>>=') after = after >> n;
      else if (op === '<<=') after = after << n;
      else if (op === '^=') after = after ^ n;
      inferredKeys[name] = { type:'numeric', value: after, origin: prev.value, loc: node.loc, op, opArg: n };
    }
  }
});

// ---- show keys
const keyNames = Object.keys(inferredKeys);
if (keyNames.length) {
  console.log("Inferred keys:");
  for (const k of keyNames) {
    const v = inferredKeys[k];
    if (v.type === 'numeric') console.log(`  ${k} = ${v.value}${v.op ? `  (from ${v.op} ${v.opArg})` : ''}`);
    else console.log(`  ${k} = "${v.value}" (concat_string)`);
  }
}

// ---- resolve array values (handles IIFE returning an ArrayExpression)
function resolveArrayValues(node) {
  // Case 1: direct literal
  if (isNumArray(node)) return node.elements.map(e => e.value);

  // Case 2: identifier with ArrayExpression init
  if (node?.type === 'Identifier') {
    const init = varDecls.get(node.name);
    if (isNumArray(init)) return init.elements.map(e => e.value);
  }

  // Case 3: IIFE producing array: (function(){ return [...]; })()
  if (node?.type === 'CallExpression'
      && node.callee?.type === 'FunctionExpression'
      && node.arguments?.length === 0) {
    const fn = node.callee;
    // find top-level ReturnStatement argument
    if (fn.body?.type === 'BlockStatement') {
      for (const stmt of fn.body.body || []) {
        if (stmt.type === 'ReturnStatement' && stmt.argument) {
          if (isNumArray(stmt.argument)) return stmt.argument.elements.map(e => e.value);
        }
      }
    }
  }

  // Case 4: map/join chains like (IIFE().map(...)).join('')
  if (node?.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'map') {
    // try resolve the object of .map()
    return resolveArrayValues(node.callee.object);
  }

  // Not resolvable
  return null;
}

// ---- collect numeric arrays (for info)
const numericArrays = [];
walkFull(ast, (node, parent) => {
  if (isNumArray(node)) numericArrays.push({ node, values: node.elements.map(e => e.value), loc: node.loc, parent });
});
console.log(`Found numeric arrays: ${numericArrays.length}`);
numericArrays.forEach((a,i)=> console.log(`[arr ${i}] len=${a.values.length} loc=${locStr(a.loc)} sample=${a.values.slice(0,12).join(',')}`));

// ---- find .map(... fromCharCode ...) sites
const mapSites = [];
walkFull(ast, (node) => {
  if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'map'
      && node.arguments?.length === 1) {

    const arrayObj = node.callee.object;
    const cb = node.arguments[0];
    if (!(cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression'))) return;

    let found = null;
    walkFull(cb.body, n => {
      if (n.type === 'CallExpression'
          && n.callee?.type === 'MemberExpression'
          && n.callee.object?.type === 'Identifier'
          && n.callee.object.name === 'String'
          && n.callee.property?.type === 'Identifier'
          && n.callee.property.name === 'fromCharCode') {
        found = n;
      }
    });
    if (!found) return;

    const arg = found.arguments && found.arguments[0];
    let transform = null, rhsNode = null;
    if (arg && arg.type === 'BinaryExpression' && ['>>','>>>','^','+','-','&','|'].includes(arg.operator)) {
      transform = arg.operator;
      rhsNode = arg.right;
    }
    mapSites.push({ node, arrayObj, cb, fromCall: found, transform, rhsNode, loc: node.loc });
  }
});

console.log(`\nCandidate .map -> fromCharCode sites: ${mapSites.length}`);
mapSites.forEach((s, idx) => {
  const arrVals = resolveArrayValues(s.arrayObj);
  console.log(`\n[site ${idx}] loc=${locStr(s.loc)} transform=${s.transform} rhs=${s.rhsNode ? (s.rhsNode.type === 'Identifier' ? s.rhsNode.name : (s.rhsNode.value || s.rhsNode.type)) : 'null'}`);
  if (arrVals) console.log(` array resolved len=${arrVals.length} sample=${arrVals.slice(0,12).join(',')}`);
  else console.log(' array unresolved (not a direct literal/identifier/IIFE).');

  const auto = tryAutoDecode(arrVals, s.transform, s.rhsNode);
  if (auto) {
    console.log(` auto-decoded (${auto.method}): ${printable(auto.text)}`);
    if (verbose) printVerbose(arrVals, auto.key || null, s.transform);
  } else {
    if (s.rhsNode && s.rhsNode.type === 'Identifier') {
      const name = s.rhsNode.name;
      const k = inferredKeys[name];
      if (k && k.type === 'numeric') {
        const dec = decodeTryXor(arrVals, k.value);
        if (dec) {
          console.log(` inferred-key ${name}=${k.value} => decoded: ${printable(dec)}`);
          if (verbose) printVerbose(arrVals, k.value, '^');
        } else {
          console.log(` inferred-key ${name}=${k.value} but xor-decode failed.`);
        }
      } else {
        console.log(` cannot auto-decode; rhs is identifier '${name}'. Compute its value then run a decode one-liner.`);
      }
    } else {
      console.log(' cannot auto-decode automatically for this transform.');
    }
  }
});

// ---- decoders
function tryAutoDecode(arrVals, op, rhsNode){
  if (!arrVals || !op) return null;
  if ((op === '>>' || op === '>>>') && rhsNode && isNumLit(rhsNode)) {
    const n = rhsNode.value;
    try { return { method: `shift:${op}${n}`, text: arrVals.map(v => String.fromCodePoint(v >>> n)).join(''), key: n }; } catch { return null; }
  }
  if (op === '^') {
    if (rhsNode && rhsNode.type === 'Literal' && typeof rhsNode.value === 'number') {
      return { method: `xor:${rhsNode.value}`, text: decodeTryXor(arrVals, rhsNode.value), key: rhsNode.value };
    }
    return null;
  }
  return null;
}
function decodeTryXor(arrVals, key){
  if (!arrVals) return null;
  try { return arrVals.map(v => String.fromCodePoint(v ^ key)).join(''); } catch { return null; }
}
function printVerbose(arrVals, key, op) {
  if (!arrVals) return;
  console.log('\nVerbose per-item detail:');
  arrVals.forEach((c, idx) => {
    let v;
    if (op === '>>' || op === '>>>') v = c >>> key;
    else if (op === '^') v = c ^ key;
    else v = c ^ key;
    console.log(`[${idx}] ${c} -> ${v} -> ${String.fromCodePoint(v)}`);
    const binC = c.toString(2).padStart(32,'0');
    const binK = (typeof key === 'number' ? (key >>> 0).toString(2).padStart(32,'0') : ''.padStart(32,' '));
    const binV = (v >>> 0).toString(2).padStart(32,'0');
    console.log(`     c:  ${binC}`);
    console.log(`     key:${binK}`);
    console.log(`     v:  ${binV}\n`);
  });
}
