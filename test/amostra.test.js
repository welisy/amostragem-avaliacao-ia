// Seleção da amostra e montagem do lote, com o código real dos nós do workflow.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregarWorkflow, rodarCode, avaliarExpressao } = require('../sandbox/n8n');
const { gerarDia, paginas } = require('../sandbox/dia-sintetico');

const { nos } = carregarWorkflow();
const CONFIG = { ...rodarCode(nos.Config)[0], criteriaId: '12' };
const FILA = { filaId: '4', label: 'Atendimento', dia: '2026-10-01' };

// --------------------------------------------------------------------------- simulação
function selecionar(chamadas, { config = {}, lotes = [{}], fila = FILA } = {}) {
  return rodarCode(nos['Seleciona Amostra'], {
    entrada: paginas(chamadas),
    saidas: { Config: { ...CONFIG, ...config }, 'Loop Filas': fila, 'Lê Lotes': lotes },
  });
}

const ids = (saida) => saida.flatMap((s) => (s.call_ids ? s.call_ids.split(',') : []));
const metadados = (saida) => saida.flatMap((s) =>
  Object.keys(s.payload).filter((k) => k.startsWith('metadata_')).map((k) => JSON.parse(s.payload[k])));

let seq = 0;
function ligacao(campos = {}) {
  seq += 1;
  return {
    call_id: String(900000 + seq), queue_id: 4, direction: 'inbound', time_connect: '2026-10-01 10:00:00',
    call_duration: 300, recording_uuid: `rec-${seq}`, caller_number: '11987654321',
    agent_name: 'Ana Souza', agent_login: 'ana', protocol_number: `P${seq}`, nps: '', csat: '', ...campos,
  };
}

// --------------------------------------------------------------------------- elegibilidade
test('sem criteriaId configurado não envia nada', () => {
  const [s] = selecionar([ligacao({ nps: '2' })], { config: { criteriaId: '0' } });
  assert.equal(s.enviar, false);
  assert.equal(s.motivo, 'criteriaId não configurado');
});

test('só entram receptivas atendidas, da fila, acima da duração mínima e com gravação', () => {
  const boa = ligacao({ nps: '3' });
  const fora = [
    ligacao({ nps: '3', direction: 'outbound' }),
    ligacao({ nps: '3', time_connect: null }),
    ligacao({ nps: '3', call_duration: 30 }),
    ligacao({ nps: '3', recording_uuid: '' }),
    ligacao({ nps: '3', queue_id: 7 }),
  ];
  const [s] = selecionar([boa, ...fora], { config: { minutosDia: 0 } });
  assert.deepEqual(ids([s]), [boa.call_id]);
  assert.equal(s.elegiveis, 1);
});

test('transferência: a mesma gravação vai uma vez só, com a perna em que caiu a pesquisa', () => {
  const p1 = ligacao({ recording_uuid: 'rec-transf', agent_login: 'ana', time_connect: '2026-10-01 10:00:00' });
  const p2 = ligacao({ recording_uuid: 'rec-transf', agent_login: 'bruno', time_connect: '2026-10-01 10:00:40', nps: '2' });
  const [s] = selecionar([p2, p1], { config: { minutosDia: 1e6 } });   // sorteio ligado: sobraria a 1ª perna
  assert.equal(s.itens, 1);
  assert.equal(s.elegiveis, 1);
  const [m] = metadados([s]);
  assert.equal(m.agente_login, 'bruno');
  assert.equal(m.amostra, 'detrator');
});

// --------------------------------------------------------------------------- classes
test('detrator por NPS ou por CSAT; neutro só quando ligado', () => {
  const det = ligacao({ nps: '6' });
  const csat = ligacao({ nps: '', csat: 'Insatisfeito' });
  const neutro = ligacao({ nps: '8' });
  const promotor = ligacao({ nps: '9' });
  const lista = [det, csat, neutro, promotor];

  const sem = selecionar(lista, { config: { minutosDia: 0 } });
  assert.deepEqual(ids(sem).sort(), [det.call_id, csat.call_id].sort());

  const com = selecionar(lista, { config: { minutosDia: 0, incluirNeutros: true } });
  assert.deepEqual(ids(com).sort(), [det.call_id, csat.call_id, neutro.call_id].sort());
  assert.equal(metadados(com).find((m) => m.id_chamada === neutro.call_id).amostra, 'neutro');
});

test('minutosDia = 0: só detratores, e o lote se chama "Detratores"', () => {
  const [s] = selecionar([ligacao({ nps: '1' }), ligacao(), ligacao()], { config: { minutosDia: 0 } });
  assert.equal(s.itens, 1);
  assert.match(s.payload.batch_name, /^\[Atendimento\] Detratores 01\/10\/2026$/);
  const [vazio] = selecionar([ligacao(), ligacao()], { config: { minutosDia: 0 } });
  assert.equal(vazio.motivo, 'nenhum detrator no dia');
});

// --------------------------------------------------------------------------- teto de minutos
test('detratores entram mesmo passando do teto, e o sorteio não acrescenta nada', () => {
  const detratores = [1, 2, 3].map(() => ligacao({ nps: '0', call_duration: 1200 }));   // 60 min
  const [s] = selecionar([...detratores, ligacao(), ligacao()], { config: { minutosDia: 40 } }); // 20 min por fila
  assert.equal(s.detratores, 3);
  assert.equal(s.sorteadas, 0);
});

test('sorteio: teto por fila e para na primeira ligação que não cabe', () => {
  const dia = gerarDia({ filas: { 4: 300, 7: 200 } });
  const todas = metadados(selecionar(dia, { config: { minutosDia: 1e6 } }))
    .filter((m) => m.amostra === 'sorteio');                // ordem completa do sorteio
  const saida = selecionar(dia, { config: { minutosDia: 600 } });
  const tetoSeg = (600 * 60) / 2;
  const meta = metadados(saida);
  const usado = meta.reduce((s, m) => s + m.duracao_s, 0);
  assert.ok(usado <= tetoSeg || meta.every((m) => m.amostra !== 'sorteio'));

  const sorteadas = meta.filter((m) => m.amostra === 'sorteio').map((m) => m.id_chamada);
  assert.ok(sorteadas.length > 10);
  assert.deepEqual(sorteadas, todas.slice(0, sorteadas.length).map((m) => m.id_chamada), 'não é um prefixo da ordem');
  const proxima = todas[sorteadas.length];
  assert.ok(usado + proxima.duracao_s > tetoSeg, 'parou antes de encher o teto');
});

test('o sorteio não puxa para as ligações curtas', () => {
  let somaAmostra = 0, nAmostra = 0, somaDia = 0, nDia = 0;
  for (let d = 1; d <= 20; d++) {
    const dia = `2026-10-${String(d).padStart(2, '0')}`;
    const chamadas = gerarDia({ dia, filas: { 4: 300 } });
    const saida = selecionar(chamadas, { fila: { ...FILA, dia }, config: { filas: { 4: {} } } });
    for (const m of metadados(saida).filter((x) => x.amostra === 'sorteio')) { somaAmostra += m.duracao_s; nAmostra += 1; }
    const sorteaveis = metadados(selecionar(chamadas, { fila: { ...FILA, dia }, config: { filas: { 4: {} }, minutosDia: 1e6 } }))
      .filter((m) => m.amostra === 'sorteio');
    for (const m of sorteaveis) { somaDia += m.duracao_s; nDia += 1; }
  }
  const razao = (somaAmostra / nAmostra) / (somaDia / nDia);
  assert.ok(razao > 0.9 && razao < 1.1, `duração média da amostra / do dia = ${razao.toFixed(2)}`);
});

// --------------------------------------------------------------------------- sorteio estável
test('sorteio estável: mesmo dia e mesma semente sorteiam as mesmas ligações', () => {
  const dia = gerarDia();
  assert.deepEqual(ids(selecionar(dia)), ids(selecionar(dia)));
  assert.notDeepEqual(ids(selecionar(dia)), ids(selecionar(dia, { config: { semente: 'outra' } })));
  assert.notDeepEqual(ids(selecionar(dia)), ids(selecionar(dia, { fila: { ...FILA, dia: '2026-10-02' } })));
});

test('uma ligação a mais no relatório não muda a ordem das outras', () => {
  const dia = gerarDia();
  const ordem = (lista) => metadados(selecionar(lista, { config: { minutosDia: 1e6 } }))
    .filter((m) => m.amostra === 'sorteio').map((m) => m.id_chamada);
  const extra = ligacao({ call_id: '777777', recording_uuid: 'rec-extra' });
  const antes = ordem(dia);
  const depois = ordem([...dia, extra]);
  assert.ok(depois.includes('777777'));
  assert.deepEqual(depois.filter((id) => id !== '777777'), antes);
});

// --------------------------------------------------------------------------- telefone e payload
test('telefone: ganha o DDI, e "0" ou vazio ficam de fora (derrubariam o lote inteiro)', () => {
  const dez = ligacao({ nps: '1', caller_number: '(11) 3333-4444' });
  const zero = ligacao({ nps: '1', caller_number: '0' });
  const vazio = ligacao({ nps: '1', caller_number: '' });
  const [s] = selecionar([dez, zero, vazio], { config: { minutosDia: 0 } });
  assert.equal(s.itens, 1);
  assert.equal(s.semTelefone, 2);
  assert.equal(s.payload.phone_number_0, '551133334444');
});

test('lotes: índices de 0 a n-1 sem buraco, nome com (1/2) e contagem por parte', () => {
  const saida = selecionar(gerarDia(), { config: { loteMax: 20 } });
  assert.ok(saida.length >= 2);
  saida.forEach((s, p) => {
    assert.match(s.payload.batch_name, new RegExp(`\\(${p + 1}/${saida.length}\\)$`));
    for (const campo of ['phone_number', 'agent', 'campaign', 'audioUrls', 'metadata']) {
      const indices = Object.keys(s.payload).filter((k) => k.startsWith(`${campo}_`)).map((k) => Number(k.split('_').pop()));
      assert.deepEqual(indices.sort((a, b) => a - b), [...Array(s.itens).keys()], campo);
      assert.ok(Object.values(s.payload).every((v) => v !== ''), 'campo vazio no payload');
    }
    assert.equal(s.detratores + s.neutros + s.sorteadas, s.itens);
  });
});

test('o token da gravação não sai do Seleciona Amostra, só o marcador', () => {
  const saida = selecionar(gerarDia(), { config: { tokenGravacao: 'TOKEN-SECRETO' } });
  const texto = JSON.stringify(saida);
  assert.ok(!texto.includes('TOKEN-SECRETO'));
  assert.match(saida[0].payload.audioUrls_0, /\?token=__TOKEN_GRAVACAO__$/);
});

test('Envia Lote troca o marcador pelo token, codificado para URL', () => {
  const [lote] = selecionar([ligacao({ nps: '1' })], { config: { minutosDia: 0 } });
  const corpo = avaliarExpressao(nos['Envia Lote'].parameters.jsonBody, {
    entrada: [lote], saidas: { Config: { ...CONFIG, tokenGravacao: 'a+b/c"d' } },
  });
  assert.ok(corpo.audioUrls_0.endsWith('?token=a%2Bb%2Fc%22d'));
  assert.equal(corpo.criteria_id, '12');
});

// --------------------------------------------------------------------------- reenvio
test('reprocessar o dia manda só o que a API ainda não aceitou', () => {
  const dia = gerarDia();
  const primeira = selecionar(dia);
  const aceitas = primeira[0].call_ids;                     // 1ª parte ok, 2ª parte falhou
  const lotes = [
    { dia: FILA.dia, fila_id: '4', status: 'ok', call_ids: aceitas },
    { dia: FILA.dia, fila_id: '4', status: 'erro', call_ids: primeira[1].call_ids },
    { dia: '2026-10-02', fila_id: '4', status: 'ok', call_ids: primeira[1].call_ids },
  ];
  const segunda = selecionar(dia, { lotes });
  assert.deepEqual(ids(segunda), ids(primeira).filter((id) => !aceitas.split(',').includes(id)));
  assert.equal(segunda[0].jaEnviadas, aceitas.split(',').length);

  const tudo = [{ dia: FILA.dia, fila_id: '4', status: 'ok', call_ids: ids(primeira).join(',') }];
  const [nada] = selecionar(dia, { lotes: tudo });
  assert.equal(nada.enviar, false);
  assert.equal(nada.motivo, 'dia já enviado');
});

// --------------------------------------------------------------------------- dia analisado
test('Lista Filas: às 21h30 no Brasil (já é amanhã em UTC) analisa o dia de hoje', () => {
  const agora = Date.UTC(2026, 9, 2, 0, 30);                // 01/10 21:30 em São Paulo
  const filas = rodarCode(nos['Lista Filas'], { saidas: { Config: CONFIG }, agora });
  assert.deepEqual(filas.map((f) => [f.filaId, f.dia]), [['4', '2026-10-01'], ['7', '2026-10-01']]);

  const reproc = rodarCode(nos['Lista Filas'], { saidas: { Config: { ...CONFIG, dataReprocesso: '2026-09-15' } }, agora });
  assert.equal(reproc[0].dia, '2026-09-15');
  assert.throws(() => rodarCode(nos['Lista Filas'], { saidas: { Config: { ...CONFIG, dataReprocesso: '15/09' } } }));
});
