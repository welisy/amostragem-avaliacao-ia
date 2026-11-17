// Gera um dia fictício de ligações no formato do relatório da telefonia, sempre igual para a mesma semente.
'use strict';

function prng(semente) {                       // mulberry32
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTES = ['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Nunes', 'Elisa Gomes', 'Fábio Reis'];
const CSAT = ['Satisfeito', 'Muito satisfeito', 'Insatisfeito'];

// filas = { '4': 300, '7': 200 } -> quantidade de ligações por fila
function gerarDia({ dia = '2026-10-01', filas = { 4: 300, 7: 200 }, semente = 1 } = {}) {
  const r = prng(semente * 7919 + Number(dia.replace(/-/g, '')));
  const hex = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const chamadas = [];
  let seq = 0;

  for (const [fila, total] of Object.entries(filas)) {
    for (let i = 0; i < total; i++) {
      seq += 1;
      const atendida = r() > 0.08;
      // 10% curtas (abaixo de 30 s); o resto com cauda longa: a maioria entre 1 e 15 min, algumas até 40
      const duracao = r() < 0.1 ? 5 + Math.floor(r() * 25)
        : Math.round(Math.min(2400, 15 + 260 * Math.exp(r() * 1.6) * (r() < 0.1 ? 3 : 1) - 200));
      const minuto = 8 * 60 + Math.floor(r() * 12 * 60);
      const hora = `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}:00`;
      const respondeu = r() < 0.18;
      const u = r();                         // ~55% promotores, ~15% neutros, ~30% detratores
      const nota = u < 0.55 ? 9 + Math.floor(r() * 2) : u < 0.7 ? 7 + Math.floor(r() * 2) : Math.floor(r() * 7);
      const agente = AGENTES[Math.floor(r() * AGENTES.length)];
      const telefone = r() < 0.03 ? (r() < 0.5 ? '0' : '') : `119${String(Math.floor(r() * 1e8)).padStart(8, '0')}`;

      const chamada = {
        call_id: String(500000 + seq),
        queue_id: Number(fila),
        direction: r() < 0.92 ? 'inbound' : 'outbound',
        time_connect: atendida ? `${dia} ${hora}` : null,
        call_duration: Math.max(5, duracao),
        recording_uuid: atendida && r() > 0.03 ? `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}` : '',
        caller_number: telefone,
        agent_name: atendida ? agente : '',
        agent_login: atendida ? agente.split(' ')[0].toLowerCase() : '',
        protocol_number: `${dia.replace(/-/g, '')}${String(seq).padStart(6, '0')}`,
        nps: respondeu ? String(nota) : '',
        csat: respondeu && r() < 0.7 ? CSAT[nota <= 4 ? 2 : nota >= 9 ? 1 : 0] : '',
      };
      chamadas.push(chamada);

      // ~5% transferidas: a mesma gravação aparece numa 2ª perna, mais tarde, com a pesquisa
      if (atendida && chamada.recording_uuid && r() < 0.05) {
        seq += 1;
        chamadas.push({
          ...chamada,
          call_id: String(500000 + seq),
          time_connect: `${dia} ${hora.slice(0, 6)}${String(30 + Math.floor(r() * 29)).padStart(2, '0')}`,
          agent_name: AGENTES[(AGENTES.indexOf(agente) + 1) % AGENTES.length],
          agent_login: AGENTES[(AGENTES.indexOf(agente) + 1) % AGENTES.length].split(' ')[0].toLowerCase(),
        });
        chamada.nps = '';
        chamada.csat = '';
      }
    }
  }
  return chamadas;
}

// Quebra a lista nas páginas de 50 que o relatório devolve (uma página = um item no n8n).
function paginas(chamadas, limite = 50) {
  const out = [];
  for (let i = 0; i < Math.max(1, chamadas.length); i += limite) {
    const fim = i + limite >= chamadas.length;
    out.push({
      data: { calls: chamadas.slice(i, i + limite) },
      pagination: { page: out.length + 1, next_url: fim ? null : `/api/v1/reports/calls?page=${out.length + 2}` },
    });
  }
  return out;
}

module.exports = { gerarDia, paginas };
