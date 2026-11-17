// Roda o código dos nós Code do workflow (o mesmo texto que vai para o n8n) fora do n8n,
// simulando só o que eles usam: $json, $input, $('Nó') e o relógio.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');

function carregarWorkflow(arquivo = 'amostragem-diaria.json') {
  const wf = JSON.parse(fs.readFileSync(path.join(RAIZ, 'workflows', arquivo), 'utf8'));
  const nos = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  return { wf, nos };
}

function exemplo(arquivo) {
  return JSON.parse(fs.readFileSync(path.join(RAIZ, 'exemplos', arquivo), 'utf8'));
}

// Date com "agora" fixo: new Date() e Date.now() devolvem o instante simulado.
function dataFixa(instante) {
  return class DataFixa extends Date {
    constructor(...args) { super(...(args.length ? args : [instante])); }
    static now() { return instante; }
  };
}

function contexto({ entrada = [], saidas = {}, agora = Date.now() }) {
  const itens = (nome) => {
    if (!(nome in saidas)) throw new Error(`Nó "${nome}" ainda não executou nesta simulação`);
    const v = saidas[nome];
    return (Array.isArray(v) ? v : [v]).map((j) => ({ json: j }));
  };
  const lista = entrada.map((j) => ({ json: j }));
  return {
    $json: entrada[0] ?? {},
    $input: { first: () => lista[0], all: () => lista },
    $: (nome) => ({ first: () => itens(nome)[0], all: () => itens(nome), get item() { return itens(nome)[0]; } }),
    Date: dataFixa(agora),
  };
}

// Executa um nó Code. `entrada` = itens que chegam no nó; `saidas` = { 'Nó': json ou [json, ...] }.
function rodarCode(no, opcoes = {}) {
  const resultado = vm.runInNewContext(`(function () {\n${no.parameters.jsCode}\n})()`, contexto(opcoes));
  // ida e volta em JSON: o n8n também serializa a saída, e os objetos deixam de ser do contexto do vm
  return JSON.parse(JSON.stringify(resultado.map((i) => i.json)));
}

// Avalia uma expressão "={{ ... }}" de um parâmetro, com o mesmo contexto dos nós Code.
function avaliarExpressao(texto, opcoes = {}) {
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(texto);
  if (!m) throw new Error(`Não é expressão: ${texto}`);
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${m[1]})`, contexto(opcoes))));
}

module.exports = { carregarWorkflow, exemplo, rodarCode, avaliarExpressao };
