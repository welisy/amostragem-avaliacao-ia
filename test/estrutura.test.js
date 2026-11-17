// Checagens do JSON do workflow: ligações válidas, referências existentes, nada sensível e docs em dia.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregarWorkflow } = require('../sandbox/n8n');

const { wf, nos } = carregarWorkflow();
const PLANILHA = ['Registra Lote', 'Registra Falha', 'Registra Dia sem Envio'];

test('toda ligação aponta para um nó que existe', () => {
  for (const [origem, { main }] of Object.entries(wf.connections)) {
    assert.ok(nos[origem], `origem inexistente: ${origem}`);
    for (const destino of main.flat()) assert.ok(nos[destino.node], `${origem} → ${destino.node} inexistente`);
  }
});

test("todo $('Nó') citado existe", () => {
  const texto = JSON.stringify(wf.nodes);
  for (const [, nome] of texto.matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) {
    assert.ok(nos[nome], `referência a nó inexistente: ${nome}`);
  }
});

test('sem credencial embutida, sem token e só domínios de exemplo', () => {
  for (const n of wf.nodes) assert.equal(n.credentials, undefined, `${n.name} traz credencial`);
  assert.match(nos.Config.parameters.jsCode, /tokenGravacao: 'COLE_O_TOKEN_DE_GRAVACAO'/);
  const urls = JSON.stringify(wf).match(/https?:\/\/[^\s"'<>{}`]+/g) || [];
  for (const u of urls) assert.match(u, /^https:\/\/[a-z]+\.exemplo\.com\b/, `URL fora do padrão: ${u}`);
});

test('Envia Lote: sem retry (POST repetido duplica a análise) e com saída de erro', () => {
  const envio = nos['Envia Lote'];
  assert.notEqual(envio.retryOnFail, true);
  assert.equal(envio.onError, 'continueErrorOutput');
  assert.deepEqual(wf.connections['Envia Lote'].main.map((s) => s[0].node), ['Registra Lote', 'Registra Falha']);
});

test('as três gravações na aba LOTES usam as mesmas colunas, na ordem do README', () => {
  const colunas = PLANILHA.map((n) => Object.keys(nos[n].parameters.columns.value));
  for (const c of colunas) assert.deepEqual(c, colunas[0]);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const linha = readme.split('\n').map((l) => l.trim()).find((l) => l.startsWith('`timestamp`'));
  assert.ok(linha, 'cabeçalho da aba não encontrado no README');
  assert.deepEqual(linha.split(' · ').map((c) => c.replace(/`/g, '').trim()), colunas[0]);
});

test('Lê Lotes devolve item mesmo com a aba vazia (senão o fluxo para na 1ª execução)', () => {
  assert.equal(nos['Lê Lotes'].alwaysOutputData, true);
  assert.equal(nos['Lê Lotes'].executeOnce, true);
});

test('o loop volta para Loop Filas por todos os caminhos', () => {
  for (const n of PLANILHA) assert.deepEqual(wf.connections[n].main[0].map((d) => d.node), ['Loop Filas']);
  assert.deepEqual(wf.connections['Loop Filas'].main.map((s) => s[0].node), ['Fim', 'Busca Chamadas']);
});
