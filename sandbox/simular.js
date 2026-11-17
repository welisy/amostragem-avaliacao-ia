// Roda o Seleciona Amostra sobre dias fictícios e mostra o que iria para a API em cada fila.
//   npm run simular                       -> 5 dias, teto do Config
//   npm run simular -- --minutos 0        -> só detratores
//   npm run simular -- --dias 10 --minutos 1500
'use strict';

const { carregarWorkflow, rodarCode } = require('./n8n');
const { gerarDia, paginas } = require('./dia-sintetico');

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 ? Number(process.argv[i + 1]) : padrao;
};

const { nos } = carregarWorkflow();
const base = rodarCode(nos.Config)[0];
const config = { ...base, criteriaId: '1', minutosDia: arg('minutos', base.minutosDia) };
const dias = arg('dias', 5);

const linhas = [];
let totalMin = 0;
for (let d = 1; d <= dias; d++) {
  const dia = `2026-10-${String(d).padStart(2, '0')}`;
  const chamadas = gerarDia({ dia });
  for (const [filaId, f] of Object.entries(config.filas)) {
    const saida = rodarCode(nos['Seleciona Amostra'], {
      entrada: paginas(chamadas),
      saidas: { Config: config, 'Loop Filas': { filaId, dia, ...f }, 'Lê Lotes': [{}] },
    });
    const soma = (campo) => saida.reduce((s, x) => s + (x[campo] || 0), 0);
    linhas.push({
      dia, fila: f.label,
      elegiveis: saida[0].elegiveis, com_pesquisa: saida[0].comPesquisa,
      detratores: soma('detratores'), neutros: soma('neutros'), sorteadas: soma('sorteadas'),
      enviadas: soma('itens'), minutos: soma('minutos'), lotes: saida.filter((x) => x.enviar).length,
    });
    totalMin += soma('minutos');
  }
}

console.log(`Teto: ${config.minutosDia} min/dia (${config.minutosDia / Object.keys(config.filas).length} por fila)\n`);
console.table(linhas);
console.log(`Média: ${Math.round(totalMin / dias)} min/dia enviados`);
