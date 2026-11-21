import { GOOGLE_DATABASE } from '../js/config.js';
import { UI_STATE_KEYS, readFilterState, writeFilterState } from '../js/ui-state.js';
import {
  getCachedDataset,
  setCachedDataset,
} from '../js/hydraulic-data-cache.js';
import { loadGoogleSheet } from '../js/google-sheets.js';
import { excelDate, norm, parseSpanishNumber } from '../js/formats.js';
import { sheetRows } from "../js/table-utils.js";
import { createHydraulicCalculator, HYDRAULIC_COLUMN_INDEXES } from '../js/hydraulic-calculations.js';
import { C, options } from './Chart.js';

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const charts = {};
const DATA_CACHE_KEY = 'estadisticos2-hydraulic-data-google';
const DATA_CACHE_VERSION = 6;
const DATA_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let calculatorCache = null;
const preparedExternalCache = new WeakMap();
const externalResultCache = new WeakMap();
let populationIndex = new Map();
let legacyLossesIndex = new Map();
let data = {
  red: [],
  acuconRows: [],
  carnfRows: [],
  aforosRows: [],
  populationRows: [],
  legacyRows: [],
  phgAnnualRows: [],
};

const number = (value) => Number(value || 0);
const key = (value, year, month) => `${norm(value)}|${year}|${month}`;

function rawRowsFromSheet(workbook) {
  return sheetRows(workbook).slice(1);
}
function cleanCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

/*
 * BD_CHG_Poblacion:
 * A = Año, B = Población, C = Nº Habitantes, D = código EM/TO.
 */
function buildPopulationIndex(rows) {
  const result = new Map();
  rows.forEach((row) => {
    const year = Number(parseSpanishNumber(row[HYDRAULIC_COLUMN_INDEXES.population.year], NaN));
    const name = norm(row[HYDRAULIC_COLUMN_INDEXES.population.name]);
    const inhabitants = parseSpanishNumber(row[HYDRAULIC_COLUMN_INDEXES.population.inhabitants], 0);
    const code = cleanCode(row[HYDRAULIC_COLUMN_INDEXES.population.code]);
    if (!Number.isFinite(year) || !name || !code) return;
    const mapKey = `${year}|${code}|${name}`;
    result.set(mapKey, (result.get(mapKey) || 0) + inhabitants);
  });
  return result;
}
function populationSum(rows, requestedPopulation, populationYear, options = {}) {
  const acceptedCodes = requestedPopulation === 0 ? new Set(['EM']) : new Set(['EM', 'TO']);
  const excluded = options.excludePopulation ? norm(options.excludePopulation) : '';
  let total = 0;
  for (const [mapKey, inhabitants] of populationIndex) {
    const [yearText, code, ...nameParts] = mapKey.split('|');
    const name = nameParts.join('|');
    if (Number(yearText) !== Number(populationYear)) continue;
    if (!acceptedCodes.has(code)) continue;
    if (excluded && name === excluded) continue;
    total += inhabitants;
  }
  return total;
}
/* BD_PDistribucion_Antiguo: A = Año; B = pérdidas en dam³/día. */
function buildLegacyLossesIndex(rows) {
  const result = new Map();
  rows.forEach((row) => {
    const year = Number(parseSpanishNumber(row[0], NaN));
    if (Number.isFinite(year)) result.set(year, parseSpanishNumber(row[1], 0));
  });
  return result;
}
function legacyLossesDaily(rows, year) {
  return legacyLossesIndex.get(Number(year)) || 0;
}

function redRecords(workbook) {
  return sheetRows(workbook).slice(1).map((row) => ({
    date: excelDate(row[0]), type: String(row[2] ?? ''), subtype: String(row[3] ?? ''),
    origin1: String(row[4] ?? ''), origin2: String(row[5] ?? ''),
    value: parseSpanishNumber(row[7], 0),
  })).filter((record) => record.date);
}
function makeCumulative(records, property) {
  const monthly = new Map();
  const result = new Map();

  records.forEach((record) => {
    const year = Number(record.date.slice(0, 4));
    const month = Number(record.date.slice(5, 7));
    const mapKey = key(record[property], year, month);
    monthly.set(mapKey, (monthly.get(mapKey) || 0) + number(record.value));
  });

  const concepts = [...new Set(records.map((record) => norm(record[property])))];
  const years = [...new Set(records.map((record) => Number(record.date.slice(0, 4))))];

  concepts.forEach((concept) => {
    years.forEach((year) => {
      let accumulated = 0;
      for (let month = 1; month <= 12; month += 1) {
        accumulated += monthly.get(`${concept}|${year}|${month}`) || 0;
        result.set(`${concept}|${year}|${month}`, accumulated);
      }
    });
  });

  return result;
}

function selectedExternal(rows, valueIndexes, year, month, dateIndex, dataDateIndex) {
  const indexes = Array.isArray(valueIndexes) ? valueIndexes : [valueIndexes];
  const referenceValue = document.getElementById('referenceDate').value;
  const referenceTimestamp = Date.parse(`${referenceValue}T23:59:59Z`);
  let resultMap = externalResultCache.get(rows);
  if (!resultMap) {
    resultMap = new Map();
    externalResultCache.set(rows, resultMap);
  }
  const resultKey = `${indexes.join(',')}|${year}|${month}|${dateIndex}|${dataDateIndex}|${referenceValue}`;
  if (resultMap.has(resultKey)) return resultMap.get(resultKey);
  let prepared = preparedExternalCache.get(rows);
  if (!prepared) {
    prepared = rows.map((row) => {
      const date = excelDate(row[dateIndex]);
      const dataDate = excelDate(row[dataDateIndex]);
      return { row,
        timestamp: date ? Date.parse(`${date}T00:00:00Z`) : NaN,
        dataTimestamp: dataDate ? Date.parse(`${dataDate}T00:00:00Z`) : NaN };
    }).filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.dataTimestamp));
    preparedExternalCache.set(rows, prepared);
  }
  let selected;
  if (month === 12) {
    const yr = prepared.filter((x) => new Date(x.timestamp).getUTCFullYear() === year);
    if (!yr.length) { resultMap.set(resultKey, 0); return 0; }
    const last = Math.max(...yr.map((x) => x.timestamp));
    selected = Math.max(...yr.filter((x) => x.timestamp === last).map((x) => x.dataTimestamp));
  } else {
    const mr = prepared.filter((x) => { const d = new Date(x.timestamp); return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && x.dataTimestamp <= referenceTimestamp; });
    if (!mr.length) { resultMap.set(resultKey, 0); return 0; } selected = Math.max(...mr.map((x) => x.dataTimestamp));
  }
  const begin=Date.UTC(year,0,1), end=Date.UTC(year,month,1);
  const result = prepared.reduce((total,x) => x.timestamp >= begin && x.timestamp < end && x.dataTimestamp === selected
    ? total + indexes.reduce((subtotal,index) => subtotal + parseSpanishNumber(x.row[index],0),0) : total, 0);
  resultMap.set(resultKey, result);
  return result;
}
function createCalculator() {
  const type = makeCumulative(data.red, 'type');
  const subtype = makeCumulative(data.red, 'subtype');
  const origin1 = makeCumulative(data.red, 'origin1');
  const origin2 = makeCumulative(data.red, 'origin2');
  const get = (map, concept, year, month) =>
    map.get(key(concept, year, month)) || 0;

  return createHydraulicCalculator({
    typeAccumulated: (concept, year, month) => get(type, concept, year, month),
    subtypeAccumulated: (concept, year, month) =>
      get(subtype, concept, year, month),
    origin1Accumulated: (concept, year, month) =>
      get(origin1, concept, year, month),
    origin2Accumulated: (concept, year, month) =>
      get(origin2, concept, year, month),

    acuconAccumulated: (index, year, month) => selectedExternal(data.acuconRows, index, year, month, 0, 1),
    externalColumnsAccumulated: (source, indexes, year, month) =>
      source === 'acucon' ? selectedExternal(data.acuconRows, indexes, year, month, 0, 1) : 0,
    carnfAccumulated: (index, year, month) => selectedExternal(data.carnfRows, index, year, month, 0, 1),
    aforosAccumulated: (index, year, month) => selectedExternal(data.aforosRows, index, year, month, 0, 1),
    populationAccumulated: (populationType, populationYear, options = {}) =>
      populationSum(data.populationRows, populationType, populationYear, options),
    legacyDistributionLossesDaily: (year) =>
      legacyLossesDaily(data.legacyRows, year),
  });
}

const horizontalBarValueLabels = {
  id: 'horizontalBarValueLabels',
  afterDatasetsDraw(chart) {
    if (chart.canvas.id !== 'unitChart') return;

    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.font = '600 10px Inter, sans-serif';
    ctx.fillStyle = '#46556b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      meta.data.forEach((bar, index) => {
        const value = Number(dataset.data[index]);
        if (!Number.isFinite(value)) return;

        const label = Math.round(value).toLocaleString('es-ES');
        const preferredX = bar.x + 6;
        const labelWidth = ctx.measureText(label).width;
        const x = Math.min(preferredX, chartArea.right - labelWidth - 2);
        ctx.fillText(label, x, bar.y);
      });
    });

    ctx.restore();
  },
};

function draw(id, type, datasets, labels, chartOptions) {
  const existingChart = charts[id];
  if (existingChart) {
    existingChart.data.labels = labels;
    existingChart.data.datasets = datasets;
    existingChart.options = chartOptions;
    existingChart.update('none');
    return;
  }
  charts[id] = new Chart(document.getElementById(id), {
    type,
    data: { labels, datasets },
    options: chartOptions,
    plugins: id === 'unitChart' ? [horizontalBarValueLabels] : [],
  });
}

const fmtVol=v=>(Number(v||0)/1000).toLocaleString('es-ES',{minimumFractionDigits:1,maximumFractionDigits:1});
const fmtPct=v=>`${(Number(v||0)*100).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})}%`;
const periods=model=>[model.annualPrevious,model.annualCurrent,model.comparePrevious,model.compareCurrent];
function periodCells(row,model){return periods(model).map(p=>`<td>${fmtVol(p[row.key])}</td><td>${fmtPct(p[row.percentKey])}</td>`).join('')}
const mainRows=[
 {label:'AGUA CAPTADA',key:'captured',percentKey:'capturedPct',cls:'major'},
 {label:'AGUA OPERACIONES DE ADUCCIÓN',key:'conveyanceOperations',percentKey:'conveyanceOperationsPct'},
 {label:'PÉRDIDAS SUBSISTEMA ADUCCIÓN',key:'conveyanceLosses',percentKey:'conveyanceLossesPct',phg:'conveyance',note:'(3)'},
 {label:'AGUA ADUCIDA',key:'conveyed',percentKey:'conveyedPct',cls:'major'},
 {label:'AGUA ADUCIDA BRUTA EXPORTADA (ABE)',key:'rawExported',percentKey:'rawExportedPct'},
 {label:'AGUA ENTRADA ETAP',key:'etapInput',percentKey:'etapInputPct',cls:'major'},
 {label:'AGUA OPERACIONES DE TRATAMIENTO',key:'treatmentOperations',percentKey:'treatmentOperationsPct'},
 {label:'PÉRDIDAS SUBSISTEMA TRATAMIENTO',key:'treatmentLosses',percentKey:'treatmentLossesPct',phg:'treatment',note:'(4)'},
 {label:'AGUA PRODUCIDA ETAP',key:'etapProduced',percentKey:'etapProducedPct',cls:'major'},
 {label:'AGUA TRATADA IMPORTADA (ATI)',key:'treatedImported',percentKey:'treatedImportedPct'},
 {label:'AGUA SUMINISTRADA (1)',key:'supplied',percentKey:'suppliedPct',cls:'major'},
 {label:'AGUA TRATADA EXPORTADA (ATE)',key:'treatedExported',percentKey:'treatedExportedPct'},
 {label:'AGUA DISTRIBUIDA',key:'distributed',percentKey:'distributedPct',cls:'major'},
 {label:'PÉRDIDAS SUBSISTEMA DISTRIBUCIÓN',key:'distributionSubsystemLosses',percentKey:'distributionSubsystemLossesPct',phg:'distribution',note:'(5)'},
];
function phgCells(row,model){const p=row.phg&&model.phg?.[row.phg];return p?`<td>${fmtVol(p.capacity)}</td><td>${fmtVol(p.targetVolume)}</td><td>${fmtPct(p.percentage)}</td><td>${row.note||''}</td>`:`<td class="phg-empty"></td><td class="phg-empty"></td><td class="phg-empty"></td><td></td>`}
function billingRows(values){const months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];return months.map((m,i)=>`<tr><td>${m}</td><td>${values[i]==null||values[i]===0?'–':`${Math.round(values[i]*100)}%`}</td></tr>`).join('')}
function smallRows(model) {
  const valueCells = (key, pct) => periods(model)
    .map((period) => `<td>${fmtVol(period[key])}</td><td>${fmtPct(period[pct])}</td>`)
    .join('');
  return [
    `<tr><td class="balance-group" rowspan="2">AGUA DISTRIBUIDA</td><td class="concept">AGUA REGISTRADA (AR)</td>${valueCells('registeredWater', 'registeredWaterPct')}</tr>`,
    `<tr><td class="concept">AGUA NO REGISTRADA (ANR)</td>${valueCells('unregisteredWater', 'unregisteredWaterPct')}</tr>`,
    `<tr><td class="balance-group" rowspan="2">AGUA SUMINISTRADA</td><td class="concept">CONSUMO AUTORIZADO FACTURADO TOTAL</td>${valueCells('totalAuthorizedBilledConsumption', 'totalAuthorizedBilledConsumptionPct')}</tr>`,
    `<tr><td class="concept">AGUA NO FACTURADA</td>${valueCells('unbilledWater', 'unbilledWaterPct')}</tr>`,
  ].join('');
}
function renderBalanceHidrico(container,model){container.innerHTML=`<section class="balance-section"><div class="balance-main"><div class="balance-title balance-title-main">BALANCE HÍDRICO</div><div class="balance-scroll"><table class="balance-table"><thead><tr><th rowspan="3" aria-label="Concepto"></th><th colspan="4">HISTÓRICO (anual)</th><th colspan="4">COMPARATIVA ${model.monthLabel}-${String(model.consultationYear).slice(-2)} (acumulado)</th><th colspan="3">PHG<br>${model.monthLabel}-${String(model.consultationYear).slice(-2)} (acumulado)</th><th rowspan="3"></th></tr><tr><th colspan="2">${model.consultationYear-2}</th><th colspan="2">${model.consultationYear-1}</th><th colspan="2">${model.monthLabel}-${String(model.consultationYear-1).slice(-2)}</th><th colspan="2">${model.monthLabel}-${String(model.consultationYear).slice(-2)}</th><th>Capacidad</th><th colspan="2">Volumen objetivo</th></tr><tr>${'<th>dam³</th><th>%</th>'.repeat(4)}<th>dam³</th><th>dam³</th><th>%</th></tr></thead><tbody>${mainRows.map(r=>`<tr class="${r.cls||''} ${r.phg?'loss':''}"><td class="concept">${r.label}</td>${periodCells(r,model)}${phgCells(r,model)}</tr>`).join('')}<tr class="system"><td>RENDIMIENTO HÍDRICO SISTEMA EMASESA (6)</td>${periodCells({key:'systemInputVolume',percentKey:'systemHydraulicEfficiency'},model)}<td colspan="4"></td></tr></tbody></table></div><div class="distributed-wrap"><div class="balance-scroll"><table class="balance-table distributed-balance-table"><colgroup><col class="distributed-col-group"><col class="distributed-col-concept">${'<col class="distributed-col-value">'.repeat(8)}</colgroup><thead><tr><th colspan="2" rowspan="3" aria-label="Conceptos"></th><th colspan="4">HISTÓRICO (anual)</th><th colspan="4">COMPARATIVA ${model.monthLabel}-${String(model.consultationYear).slice(-2)} (acumulado)</th></tr><tr><th colspan="2">${model.consultationYear-2}</th><th colspan="2">${model.consultationYear-1}</th><th colspan="2">${model.monthLabel}-${String(model.consultationYear-1).slice(-2)}</th><th colspan="2">${model.monthLabel}-${String(model.consultationYear).slice(-2)}</th></tr><tr>${'<th>dam³</th><th>%</th>'.repeat(4)}</tr></thead><tbody>${smallRows(model)}</tbody></table></div><div class="distributed-notes"><p><b>Agua registrada</b> = Consumo Registrado Facturado + Consumo Registrado No Facturado</p><p><b>Agua no registrada</b> = Pérdidas Aparentes + Pérdidas Reales + Consumo Autorizado No Registrado</p><p><b>Consumo autorizado facturado total</b> = Consumo Registrado Facturado + Consumo No Registrado Facturado + ATE</p><p><b>Agua no facturada</b> = Volumen suministrado − Consumo Autorizado Facturado Total</p></div></div></div><aside class="billing-panel"><div class="balance-title">FACTURACIÓN REAL<br>AÑO ${model.consultationYear}</div><table class="billing-table"><thead><tr><th>Mes</th><th>Porcentaje</th></tr></thead><tbody>${billingRows(model.realBilling)}</tbody></table></aside><div class="balance-notes"><h3>Notas:</h3><ol><li>Considerar el Volumen en Depósitos en el Agua Producida ETAP.</li><li>El consumo Autorizado Facturado TOTAL, incluye el Agua Tratada Exportada y los Aforos.</li><li>Pérdidas máximas en aducción: 5%. Hasta 2017 se calcula según la capacidad de transporte, 12,6 m³/h (PH 2009-2015). Desde 2018 según el volumen captado, máximo un 5% por cada 100km de conducción (PH 2016-2021). Se consideran 100km de conducciones.</li><li>Pérdidas máximas en tratamiento: 5%. Hasta 2017 se calcula según la capacidad de tratamiento, 10,0 m³/h (PH 2009-2015). Cierre 2018: según volumen captado. Desde 2019: según el volumen entrada ETAP (PH 2016-2021, acordado con CHG).</li><li>Eficiencia mínima distribución: 80%. Hasta 2018 se calcula según el volumen captado (PH 2009-2015 y PH 2016-2021). Desde 2019 según el volumen suministrado (PH 2016-2021, acordado con CHG).</li><li class="note6">Corresponde al volumen efectivamente utilizado para el suministro respecto al total introducido en el sistema:\nRendimiento Hídrico = Salidas autorizadas y controladas / Total entrada al sistema, donde el Total entrada al sistema corresponde a las extracciones totales anuales de agua del medioambiente, calculado como Captado (embalses + pozos) + ATI. En la celda de volumen se indica el volumen total de entrada de cada anualidad.</li></ol></div></section>`}



const supplementaryPeriods = (calculator, year, month) => [
  { year: year - 2, month: 12 },
  { year: year - 1, month: 12 },
  { year: year - 1, month },
  { year, month },
];
const supplementaryValue = (calculator, concept, period) =>
  calculator.accumulated(concept, period.year, period.month);
const supplementaryVolumeCells = (calculator, concept, periods) => {
  const values = periods.map((period) => fmtVol(supplementaryValue(calculator, concept, period)));
  return `<td class="numeric-value">${values[0]}</td><td class="numeric-value">${values[1]}</td><td class="water-band"></td><td class="numeric-value">${values[2]}</td><td class="numeric-value">${values[3]}</td>`;
};
const supplementaryMergedVolumeCells = (calculator, concept, periods) => {
  const values = periods.map((period) => fmtVol(supplementaryValue(calculator, concept, period)));
  return `<td rowspan="2" class="numeric-value loss-highlight">${values[0]}</td><td rowspan="2" class="numeric-value loss-highlight">${values[1]}</td><td rowspan="2" class="numeric-value loss-highlight">${values[2]}</td><td rowspan="2" class="numeric-value loss-highlight">${values[3]}</td>`;
};
const supplementaryEfficiencyCells = (calculator, concept, periods) =>
  periods.map((period) => `<td class="numeric-value">${fmtPct(supplementaryValue(calculator, concept, period))}</td>`).join('');
function renderSupplementaryBlocks(container, calculator, consultationYear, consultationMonth) {
  const periodList = supplementaryPeriods(calculator, consultationYear, consultationMonth);
  const previousYear = consultationYear - 1;
  const historicStartYear = consultationYear - 2;
  const monthName = MONTHS[consultationMonth - 1].toUpperCase();
  const efficiencyRows = [
    {
      label: 'Rdto. Subsistema Aducción',
      key: 'conveyanceSubsystemEfficiency',
      formula: '<i>RH<sub>Aducción</sub></i> = (Entrada ETAP + ABE + Agua Operaciones Aducción) / Agua Captada',
    },
    {
      label: 'Rdto. Subsistema Tratamiento',
      key: 'treatmentSubsystemEfficiency',
      formula: '<i>RH<sub>Tratamiento</sub></i> = (Producida ETAP + Agua Operaciones Tratamiento) / Agua Entrada ETAP',
    },
    {
      label: 'Rdto. Subsistema Distribución',
      key: 'distributionSubsystemEfficiency',
      formula: '<i>RH<sub>Distribución</sub></i> = (Consumo Autorizado + Agua Tratada Exportada) / Agua Suministrada',
    },
  ];
  const volume = (key) => supplementaryVolumeCells(calculator, key, periodList);
  const fraudCells = supplementaryMergedVolumeCells(calculator, 'fraudAndAvoidableLosses', periodList);
  const html = `
    <section class="supplementary-card efficiency-block">
      <div class="supplementary-title">INDICADORES DE EFICIENCIA HÍDRICA</div>
      <div class="supplementary-scroll">
        <table class="supplementary-table efficiency-table">
          <thead>
            <tr><th rowspan="2">CONCEPTO</th><th colspan="2">HISTÓRICO (anual)</th><th colspan="2">COMPARATIVA ${monthName}</th><th rowspan="2">FÓRMULA</th></tr>
            <tr><th>${historicStartYear}</th><th>${previousYear}</th><th>${previousYear}</th><th>${consultationYear}</th></tr>
          </thead>
          <tbody>${efficiencyRows.map((row) => `<tr><td>${row.label}</td>${supplementaryEfficiencyCells(calculator, row.key, periodList)}<td class="formula-cell">${row.formula}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </section>
    <section class="supplementary-card distributed-detail-block">
      <div class="supplementary-title">DESGLOSE DE VOLUMEN DE AGUA DISTRIBUIDO</div>
      <div class="supplementary-scroll">
        <table class="supplementary-table distributed-detail-table">
          <colgroup>
            <col class="col-group"><col class="col-subgroup"><col class="col-concept">
            <col class="col-year"><col class="col-year"><col class="col-water">
            <col class="col-compare"><col class="col-compare"><col class="col-origin">
          </colgroup>
          <thead>
            <tr><th colspan="2" rowspan="2">DESGLOSE DE VOLUMEN DE AGUA DISTRIBUIDA<br><span>(dam³)</span></th><th rowspan="2">Datos Periodo ANUAL</th><th rowspan="2">${historicStartYear}</th><th rowspan="2">${previousYear}</th><th rowspan="2" class="water-band-head"></th><th colspan="2">COMPARATIVA ${monthName}</th><th rowspan="2">Informe Origen</th></tr>
            <tr><th>${previousYear}</th><th>${consultationYear}</th></tr>
          </thead>
          <tbody>
            <tr><td rowspan="4" class="group-cell">CONSUMO<br>AUTORIZADO</td><td rowspan="2" class="subgroup-cell">Consumo Autorizado Registrado</td><td>Consumo Registrado Facturado</td>${volume('registeredBilledConsumption').replace('<td class="water-band"></td>', '<td rowspan="2" class="water-band registered-band">Agua Registrada</td>')}<td class="origin-cell">ACUCON-CONSPRE</td></tr>
            <tr><td>Consumo Registrado NO Facturado (7)</td>${volume('registeredUnbilledConsumption').replace('<td class="water-band"></td>', '')}<td class="origin-cell no-fill normal-weight">Consultas BI, Volumen zonas deprimidas y eventos</td></tr>
            <tr><td rowspan="2" class="subgroup-cell">Consumo Autorizado No Registrado</td><td>Consumo NO Registrado Facturado (8)</td>${volume('unregisteredBilledConsumption').replace('<td class="water-band"></td>', '<td rowspan="6" class="water-band unregistered-band">Agua No Registrada</td>')}<td class="origin-cell">Consulta botones AQUAWS</td></tr>
            <tr><td>Consumo NO Registrado NO Facturado (9)</td>${volume('unregisteredUnbilledConsumption').replace('<td class="water-band"></td>', '')}<td class="origin-cell no-fill normal-weight">Consulta BI</td></tr>
            <tr><td rowspan="4" class="group-cell">PÉRDIDAS</td><td rowspan="2" class="subgroup-cell">Pérdidas Aparentes</td><td>Imprecisión Equipos de Medida</td>${volume('meteringInaccuracy').replace('<td class="water-band"></td>', '')}<td class="origin-cell">Informe de Imprecisión de Equipos anual</td></tr>
            <tr><td>Consumo NO Autorizado (Fraudes)</td>${fraudCells}<td rowspan="2" class="origin-cell no-fill normal-weight">Obtenido por diferencia</td></tr>
            <tr><td rowspan="2" class="subgroup-cell">Pérdidas Reales</td><td class="no-fill normal-weight">Pérdidas Evitables</td></tr>
            <tr><td>Pérdidas Técnicas Mínimas (UARL)</td>${volume('minimumTechnicalLosses').replace('<td class="water-band"></td>', '')}<td class="origin-cell no-fill normal-weight">Informe ILI</td></tr>
          </tbody>
        </table>
      </div>
      <div class="supplementary-footnotes"><div>(7) Riegos y Baldeos, Consumos Propios, Purgas Contabilizadas, Consumo del Vacie</div><div>(8) Aforos</div><div>(9) Consumo de Mantenimiento</div></div>
    </section>`;
  container.insertAdjacentHTML('beforeend', html);
}

function hasAcuconBillingData(year, month) {
  const referenceValue = document.getElementById('referenceDate')?.value;
  const referenceTimestamp = Date.parse(`${referenceValue}T23:59:59Z`);

  const monthlyRows = data.acuconRows
    .map((row) => {
      const date = excelDate(row[HYDRAULIC_COLUMN_INDEXES.acucon.date]);
      const dataDate = excelDate(row[HYDRAULIC_COLUMN_INDEXES.acucon.dataDate]);
      return {
        row,
        date,
        timestamp: date ? Date.parse(`${date}T00:00:00Z`) : NaN,
        dataTimestamp: dataDate ? Date.parse(`${dataDate}T00:00:00Z`) : NaN,
      };
    })
    .filter((item) => {
      if (!Number.isFinite(item.timestamp) || !Number.isFinite(item.dataTimestamp)) return false;
      const date = new Date(item.timestamp);
      return date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month &&
        item.dataTimestamp <= referenceTimestamp;
    });

  if (!monthlyRows.length) return false;

  const selectedDataTimestamp = Math.max(...monthlyRows.map((item) => item.dataTimestamp));
  return monthlyRows.some((item) =>
    item.dataTimestamp === selectedDataTimestamp &&
    parseSpanishNumber(
      item.row[HYDRAULIC_COLUMN_INDEXES.acucon.totalRegisteredBilled],
      0,
    ) > 0,
  );
}

function createBalanceModel(calculator, consultationYear, consultationMonth) {
  const buildPeriod = (year, month) => {
    const v = (concept) => calculator.accumulated(concept, year, month);
    const captured = v('captured');
    const supplied = v('supplied');
    const distributed = v('distributed');
    const ratio = (a, b) => b ? a / b : 0;
    const period = {
      captured, conveyanceOperations: v('conveyanceOperations'),
      conveyanceLosses: v('conveyanceLosses'), conveyed: v('conveyed'),
      rawExported: v('rawExported'), etapInput: v('etapInput'),
      treatmentOperations: v('treatmentOperations'), treatmentLosses: v('treatmentLosses'),
      etapProduced: v('etapProduced'), treatedImported: v('treatedImported'),
      supplied, treatedExported: v('treatedExported'), distributed,
      distributionSubsystemLosses: v('distributionSubsystemLosses'),
      systemInputVolume: v('systemInputVolume'), systemHydraulicEfficiency: v('systemHydraulicEfficiency'),
      registeredWater: v('registeredWater'), unregisteredWater: v('unregisteredWater'),
      totalAuthorizedBilledConsumption: v('authorizedBilledConsumption'), unbilledWater: v('nonRevenueWater'),
    };
    const capturedKeys = ['captured','conveyanceOperations','conveyanceLosses','conveyed','rawExported','etapInput','treatmentOperations','treatmentLosses','etapProduced','treatedImported','supplied','treatedExported'];
    capturedKeys.forEach((key) => { period[`${key}Pct`] = ratio(period[key], captured); });
    period.distributedPct = ratio(distributed, captured);
    period.distributionSubsystemLossesPct = ratio(period.distributionSubsystemLosses, distributed);
    period.registeredWaterPct = ratio(period.registeredWater, distributed);
    period.unregisteredWaterPct = ratio(period.unregisteredWater, distributed);
    period.totalAuthorizedBilledConsumptionPct = ratio(period.totalAuthorizedBilledConsumption, supplied);
    period.unbilledWaterPct = ratio(period.unbilledWater, supplied);
    return period;
  };
  const annualPrevious = buildPeriod(consultationYear - 2, 12);
  const annualCurrent = buildPeriod(consultationYear - 1, 12);
  const comparePrevious = buildPeriod(consultationYear - 1, consultationMonth);
  const compareCurrent = buildPeriod(consultationYear, consultationMonth);

  // BD_PHG_Anual: fila 1 = capacidad de aducción; fila 2 = tratamiento.
  const conveyanceAnnualCapacityM3 =
    parseSpanishNumber(data.phgAnnualRows[0]?.[0], 0) * 1000;
  const treatmentAnnualCapacityM3 =
    parseSpanishNumber(data.phgAnnualRows[1]?.[0], 0) * 1000;
  const capacityRatio = (value, capacity) => capacity ? value / capacity : 0;
  const applyHistoricalCapacityPercentages = (period) => {
    period.conveyanceOperationsPct = capacityRatio(period.conveyanceOperations, conveyanceAnnualCapacityM3);
    period.treatmentOperationsPct = capacityRatio(period.treatmentOperations, treatmentAnnualCapacityM3);
    period.treatmentLossesPct = capacityRatio(period.treatmentLosses, treatmentAnnualCapacityM3);
  };
  applyHistoricalCapacityPercentages(annualPrevious);
  applyHistoricalCapacityPercentages(annualCurrent);
  const days = Math.round((Date.UTC(consultationYear, consultationMonth, 1) - Date.UTC(consultationYear, 0, 1)) / 86400000);
  const annualDays = Math.round((Date.UTC(consultationYear + 1, 0, 1) - Date.UTC(consultationYear, 0, 1)) / 86400000);
  const phgRow = data.phgAnnualRows.find((row) => Number(parseSpanishNumber(row[0], NaN)) === consultationYear);
  const historicConveyance = phgRow ? parseSpanishNumber(phgRow[1], 0) * days / annualDays : 0;
  const historicTreatment = phgRow ? parseSpanishNumber(phgRow[2], 0) * days / annualDays : 0;
  const conveyanceCapacity = consultationYear <= 2017 && historicConveyance > 0 ? historicConveyance : compareCurrent.captured;
  const treatmentCapacity = consultationYear <= 2017 && historicTreatment > 0 ? historicTreatment : consultationYear === 2018 ? compareCurrent.captured : compareCurrent.etapInput;
  const distributionCapacity = compareCurrent.distributed;

  // Comparativa acumulada: porcentajes respecto a la capacidad PHG acumulada.
  const accumulatedPhgCapacities = (period, year) => ({
    conveyance: year <= 2017 && historicConveyance > 0 ? historicConveyance : period.captured,
    treatment: year <= 2017 && historicTreatment > 0
      ? historicTreatment
      : year === 2018 ? period.captured : period.etapInput,
  });
  const applyAccumulatedPhgPercentages = (period, year) => {
    const capacities = accumulatedPhgCapacities(period, year);
    period.conveyanceOperationsPct = capacityRatio(period.conveyanceOperations, capacities.conveyance);
    period.treatmentOperationsPct = capacityRatio(period.treatmentOperations, capacities.treatment);
    period.treatmentLossesPct = capacityRatio(period.treatmentLosses, capacities.treatment);
  };
  applyAccumulatedPhgPercentages(comparePrevious, consultationYear - 1);
  applyAccumulatedPhgPercentages(compareCurrent, consultationYear);
  return {
    consultationYear,
    monthLabel: MONTHS[consultationMonth - 1].slice(0, 3).toLowerCase(),
    annualPrevious, annualCurrent, comparePrevious, compareCurrent,
    phg: {
      conveyance: { capacity: conveyanceCapacity, targetVolume: conveyanceCapacity * 0.05, percentage: 0.05 },
      treatment: { capacity: treatmentCapacity, targetVolume: treatmentCapacity * 0.05, percentage: 0.05 },
      distribution: { capacity: distributionCapacity, targetVolume: distributionCapacity * 0.20, percentage: 0.20 },
    },
    realBilling: Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      return hasAcuconBillingData(consultationYear, month)
        ? calculator.accumulated('realBilling', consultationYear, month)
        : null;
    }),
  };
}
function updateBalanceSection(calculator, consultationYear, consultationMonth) {
  let container = document.getElementById('balanceHydraulicSection');
  if (!container) {
    container = document.createElement('div');
    container.id = 'balanceHydraulicSection';
    const grid = document.querySelector('.estadisticos2-grid') || document.querySelector('.dashboard-grid');
    grid?.insertAdjacentElement('afterend', container);
  }
  renderBalanceHidrico(container, createBalanceModel(calculator, consultationYear, consultationMonth));
  renderSupplementaryBlocks(container, calculator, consultationYear, consultationMonth);
}

function formatReferenceDate(value) {
  if (!value) return 'Sin fecha';
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}
function updateConsultationStatus(consultationYear, consultationMonth) {
  const status = document.getElementById('consultationStatusValue');
  const referenceDate = document.getElementById('referenceDate')?.value;
  if (!status) return;
  status.innerHTML = `
    <span class="status-field-label">Fecha consulta:</span>
    <strong class="status-field-value">${MONTHS[consultationMonth - 1]} ${consultationYear}</strong>
    <span class="status-separator">-</span>
    <span class="status-field-label">Fecha referencia:</span>
    <strong class="status-field-value">${formatReferenceDate(referenceDate)}</strong>
  `;
}

function waitForProgressPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setUpdateProgress(_step, message) {
  const messageElement = document.getElementById('updateProgressMessage');
  const bar = document.getElementById('updateProgressBar');
  if (messageElement) messageElement.textContent = message;
  if (bar) bar.style.width = '';
}

function showUpdateProgress() {
  const panel = document.getElementById('updateProgress');
  if (!panel) return;
  panel.classList.add('is-visible');
  panel.setAttribute('aria-hidden', 'false');
  setUpdateProgress('read', 'Leyendo los datos necesarios para la consulta.');
}

function hideUpdateProgress() {
  const panel = document.getElementById('updateProgress');
  if (!panel) return;
  panel.classList.remove('is-visible');
  panel.setAttribute('aria-hidden', 'true');
}

async function updateCharts({ showFeedback = true } = {}) {
  const printButton = document.getElementById('print');
  if (showFeedback) {
    if (printButton) printButton.disabled = true;
    showUpdateProgress();
    await waitForProgressPaint();
  }
  try {
  const consultationYear = Number(document.getElementById('year').value);
  const consultationMonth = Number(document.getElementById('month').value);
  const labels = Array.from(
    { length: 11 },
    (_, index) => consultationYear - 10 + index,
  );
  const calculator = calculatorCache ?? (calculatorCache = createCalculator());
  if (showFeedback) {
    setUpdateProgress('calculate', 'Calculando balances, rendimientos e indicadores hidráulicos.');
    await waitForProgressPaint();
  }

  const series = (concept) =>
    labels.map((year) =>
      calculator.accumulated(
        concept,
        year,
        year === consultationYear ? consultationMonth : 12,
      ),
    );

  const days = labels.map((year) => {
    const month = year === consultationYear ? consultationMonth : 12;
    return Math.round(
      (Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) / 86400000,
    );
  });
  const dailyDam3 = (concept) =>
    series(concept).map((value, index) => value / 1000 / days[index]);

  if (showFeedback) {
    setUpdateProgress('render', 'Actualizando las gráficas, tablas y datos presentados.');
    await waitForProgressPaint();
  }

  draw(
    'balanceChart',
    'line',
    [
      { label: 'Agua captada', data: dailyDam3('captured'), borderColor: C.captured, backgroundColor: C.captured, tension: 0.3, yAxisID: 'y' },
      { label: 'Agua suministrada', data: dailyDam3('supplied'), borderColor: C.supplied, backgroundColor: C.supplied, tension: 0.3, yAxisID: 'y' },
      { label: 'Pérdidas subsistema distribución', data: dailyDam3('distributionSubsystemLosses'), borderColor: C.losses, backgroundColor: C.losses, tension: 0.3, yAxisID: 'y' },
      { label: 'Porcentaje pérdidas distribución', data: series('distributionLossPercentage').map((value) => value * 100), borderColor: C.percentage, backgroundColor: C.percentage, tension: 0.3, yAxisID: 'yp' },
    ],
    labels,
    {
      ...options(),
      scales: {
        ...options().scales,
        yp: {
          position: "right",
          // Eje secundario fijo del 0 % al 60 %.
          min: 0,
          max: 60,
          grid: {drawOnChartArea: false},
          ticks: {
            stepSize: 10,
            callback: (value) =>
              `${value}%`,
          },
        },
      },
    },
  );

  const domesticUnitSeries = series('domesticUnitConsumption');
  const allocationSeries = series('allocation');
  const maximumUnitValue = Math.max(
    ...domesticUnitSeries,
    ...allocationSeries,
    0,
  );
  const dynamicUnitMaximum =
    maximumUnitValue > 0
      ? Math.ceil((maximumUnitValue * 1.06) / 5) * 5
      : 10;

  draw(
    'unitChart',
    'bar',
    [
      { label: 'Consumo unitario doméstico', data: domesticUnitSeries, backgroundColor: C.domestic, borderRadius: 4 },
      { label: 'Dotación', data: allocationSeries, backgroundColor: C.allocation, borderRadius: 4 },
    ],
    labels,
    {
      ...options('l/hab/día'),
      indexAxis: 'y',
      interaction: {
        mode: 'index',
        axis: 'y',
        intersect: false,
      },
      plugins: {
        ...options('l/hab/día').plugins,
        tooltip: {
          mode: 'index',
          axis: 'y',
          intersect: false,
          displayColors: true,
          usePointStyle: true,
          padding: 12,
          titleSpacing: 8,
          bodySpacing: 7,
          callbacks: {
            title: (items) => `Año ${items[0].label}`,
            label: (context) =>
              ` ${context.dataset.label}: ${Math.round(Number(context.raw)).toLocaleString('es-ES')} l/hab/día`,
          },
        },
      },
      layout: {
        padding: { right: 8 },
      },
      scales: {
        y: {
          reverse: true,
          grid: { display: false },
        },
        x: {
          beginAtZero: true,
          max: dynamicUnitMaximum,
          grid: { color: '#edf1f5' },
        },
      },
    },
  );

  draw(
    'efficiencyChart',
    'line',
    [
      { label: 'Aducción', data: series('conveyanceSubsystemEfficiency').map((value) => value * 100), borderColor: C.conveyance, tension: 0.3 },
      { label: 'Tratamiento', data: series('treatmentSubsystemEfficiency').map((value) => value * 100), borderColor: C.treatment, tension: 0.3 },
      { label: 'Distribución', data: series('distributionSubsystemEfficiency').map((value) => value * 100), borderColor: C.distribution, tension: 0.3 },
    ],
    labels,
    options('%', true),
  );

  draw(
    'lossIndexChart',
    'line',
    [
      { label: 'Índice pérdidas distribución', data: series('distributionLossIndex'), borderColor: C.index, backgroundColor: '#ef444420', fill: true, tension: 0.3 },
    ],
    labels,
    options(),
  );
  updateBalanceSection(calculator, consultationYear, consultationMonth);
  updateConsultationStatus(consultationYear, consultationMonth);
  } finally {
    if (showFeedback) {
      if (printButton) printButton.disabled = false;
      hideUpdateProgress();
    }
  }
}

async function loadStatistics2Data() {
  try {
    const cached = await getCachedDataset(DATA_CACHE_KEY, {
      version: DATA_CACHE_VERSION,
      maxAgeMs: DATA_CACHE_TTL_MS,
    });
    if (cached) return cached;
  } catch (error) {
    console.warn('No se pudo leer la caché hidráulica de IndexedDB.', error);
  }

  const sheets = GOOGLE_DATABASE.sheets;
  const sheetNames = [
    sheets.datosRed,
    sheets.datosAcucon,
    sheets.datosCarnf,
    sheets.datosAforosPerdidas,
    sheets.chgPoblacion,
    sheets.pDistribucionAntiguo || 'BD_PDistribucion_Antiguo',
    sheets.phgAnual || 'BD_PHG_Anual',
  ];
  const books = await Promise.all(
    sheetNames.map((sheetName, index) => loadGoogleSheet(sheetName, index === 0 ? 1 : 0)),
  );
  const loaded = {
    red: redRecords(books[0]),
    acuconRows: rawRowsFromSheet(books[1]),
    carnfRows: rawRowsFromSheet(books[2]),
    aforosRows: rawRowsFromSheet(books[3]),
    populationRows: sheetRows(books[4]),
    legacyRows: sheetRows(books[5]),
    phgAnnualRows: sheetRows(books[6]),
  };
  setCachedDataset(DATA_CACHE_KEY, loaded, { version: DATA_CACHE_VERSION })
    .catch((error) => console.warn('No se pudo guardar la caché hidráulica de IndexedDB.', error));
  return loaded;
}
async function init() {
  const monthSelect = document.getElementById('month');
  const yearSelect = document.getElementById('year');
  const referenceDateInput = document.getElementById('referenceDate');
  MONTHS.forEach((name, index) => monthSelect.add(new Option(name, index + 1)));

  data = await loadStatistics2Data();

  // MES y AÑO: rango e inicio calculados desde FECHA,
  // primera columna de BD_Datos_Red.
  const redDates = data.red
    .map((record) => record.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const minimumRedDate = redDates.at(0);
  const maximumRedDate = redDates.at(-1);
  if (!minimumRedDate || !maximumRedDate) {
    throw new Error('BD_Datos_Red no contiene fechas válidas para generar los filtros MES y AÑO.');
  }

  const minimumYear = Number(minimumRedDate.slice(0, 4));
  const maximumYear = Number(maximumRedDate.slice(0, 4));
  const initialMonth = Number(maximumRedDate.slice(5, 7));
  const initialYear = maximumYear;

  for (let year = minimumYear; year <= maximumYear; year += 1) {
    yearSelect.add(new Option(year, year));
  }

  // FECHA REFERENCIA: fecha máxima de la segunda columna de BD_Datos_ACUCON.
  const acuconReferenceDates = data.acuconRows
    .map((row) => excelDate(row[1]))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const minimumReferenceDate = acuconReferenceDates.at(0);
  const maximumReferenceDate = acuconReferenceDates.at(-1);
  if (!minimumReferenceDate || !maximumReferenceDate) {
    throw new Error('BD_Datos_ACUCON no contiene fechas válidas en su segunda columna para FECHA REFERENCIA.');
  }

  const today = new Date();
  const todayIso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');

  referenceDateInput.min = minimumReferenceDate;
  referenceDateInput.max = todayIso;

  // Primera entrada: máximos disponibles. Al volver desde otra pantalla,
  // se conserva la última selección siempre que siga siendo válida.
  const savedFilters = readFilterState(UI_STATE_KEYS.statistics2, {
    month: initialMonth,
    year: initialYear,
    referenceDate: maximumReferenceDate,
  });
  const savedMonth = Number(savedFilters.month);
  const savedYear = Number(savedFilters.year);
  const savedReferenceDate = String(savedFilters.referenceDate || '');

  monthSelect.value =
    savedMonth >= 1 && savedMonth <= 12 ? savedMonth : initialMonth;
  yearSelect.value =
    savedYear >= minimumYear && savedYear <= maximumYear
      ? savedYear
      : initialYear;
  referenceDateInput.value =
    /^\d{4}-\d{2}-\d{2}$/.test(savedReferenceDate) &&
    savedReferenceDate >= minimumReferenceDate &&
    savedReferenceDate <= todayIso
      ? savedReferenceDate
      : maximumReferenceDate;

  populationIndex = buildPopulationIndex(data.populationRows);
  legacyLossesIndex = buildLegacyLossesIndex(data.legacyRows);
  calculatorCache = createCalculator();

  const testCalculator = calculatorCache;
  const testPopulation = testCalculator.accumulated('emasesaPopulation', 2023, 8);
  const testConveyancePopulation = testCalculator.accumulated('conveyancePopulation', 2023, 8);
  if (testPopulation <= 0 || testConveyancePopulation <= 0) {
    throw new Error(`BD_CHG_Poblacion no devolvió población válida para 2022 (EM=${testPopulation}; EM+TO=${testConveyancePopulation})`);
  }
  await updateCharts({ showFeedback: false });
  document.getElementById('loading').style.display = 'none';
}
function formatTodayDate() {
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}
const todayDate = document.getElementById('todayDate');
if (todayDate) todayDate.textContent = formatTodayDate();

let automaticUpdateFrame = 0;
const scheduleAutomaticUpdate = () => {
  writeFilterState(UI_STATE_KEYS.statistics2, {
    month: Number(document.getElementById('month').value),
    year: Number(document.getElementById('year').value),
    referenceDate: document.getElementById('referenceDate').value,
  });
  cancelAnimationFrame(automaticUpdateFrame);
  automaticUpdateFrame = requestAnimationFrame(() => updateCharts());
};
['month','year','referenceDate'].forEach((id) => document.getElementById(id).addEventListener('change', scheduleAutomaticUpdate));
function refreshChartsForPrint() {
  Object.values(charts).forEach((chartInstance) => {
    if (!chartInstance) return;
    chartInstance.resize();
    chartInstance.update('none');
  });
}
window.addEventListener('beforeprint', refreshChartsForPrint);
window.addEventListener('afterprint', () => requestAnimationFrame(refreshChartsForPrint));
document.getElementById('print').addEventListener('click', () => {
  requestAnimationFrame(() => {
    refreshChartsForPrint();
    requestAnimationFrame(() => window.print());
  });
});

init().catch((error) => {
  console.error(error);
  document.getElementById('loading').textContent =
    `No se pudieron cargar los datos: ${error.message}`;
});
