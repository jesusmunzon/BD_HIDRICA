import {
  GOOGLE_DATABASE
} from '../js/config.js';
import {
  loadGoogleSheet
} from '../js/google-sheets.js';
import {
  getCachedDataset,
  setCachedDataset
} from '../js/hydraulic-data-cache.js';
import {
  UI_STATE_KEYS,
  readFilterState,
  writeFilterState
} from '../js/ui-state.js';
import {
  createHydraulicCalculator
} from '../js/hydraulic-calculations.js';
import {
  excelDate,
  norm,
  parseSpanishNumber
} from '../js/formats.js';
import {
  sheetRows
} from '../js/table-utils.js';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto',
  'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];
const CACHE_KEY = 'estadisticos4-hydraulic-data',
  CACHE_VERSION = 4,
  CACHE_AGE = 12 * 60 * 60 * 1000;
let data = {
    red: [],
    balance: [],
    distributionConfig: [],
    populationRows: []
  },
  calculator, calculatorMaps = null,
  distributionRules = new Map(),
  balanceMonthDevice = new Map(),
  populationIndex = new Map();
const n = v => Number(parseSpanishNumber(v, 0) || 0),
  clean = v => norm(v).replace(/\s+/g, ' ').trim(),
  key = (v, y, m) => `${clean(v)}|${y}|${m}`;

function redRecords(rows) {
  return rows.map(r => ({
    date: excelDate(r[0]),
    type: String(r[2] || ''),
    subtype: String(r[3] || ''),
    origin1: String(r[4] || ''),
    origin2: String(r[5] || ''),
    value: n(r[7])
  })).filter(r => r.date)
}

function cumulativeComposite(records, originProperty) {
  const prepared = records.map(r => ({
    ...r,
    composite: `${clean(r.subtype)}§${clean(r[originProperty])}`
  }));
  return cumulative(prepared, 'composite')
}

function cumulative(records, property) {
  const monthly = new Map(),
    result = new Map(),
    concepts = new Set(),
    years = new Set();
  for (const r of records) {
    const y = +r.date.slice(0, 4),
      m = +r.date.slice(5, 7),
      c = clean(r[property]);
    monthly.set(`${c}|${y}|${m}`, (monthly.get(`${c}|${y}|${m}`) || 0) + r.value);
    concepts.add(c);
    years.add(y)
  }
  for (const c of concepts)
    for (const y of years) {
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        total += monthly.get(`${c}|${y}|${m}`) || 0;
        result.set(`${c}|${y}|${m}`, total)
      }
    }
  return result
}

function buildCalculator() {
  const records = redRecords(data.red);
  calculatorMaps = {
    type: cumulative(records, 'type'),
    subtype: cumulative(records, 'subtype'),
    origin1: cumulative(records, 'origin1'),
    origin2: cumulative(records, 'origin2'),
    subtypeOrigin1: cumulativeComposite(records, 'origin1'),
    subtypeOrigin2: cumulativeComposite(records, 'origin2')
  };
  const get = (map, c, y, m) => map.get(key(c, y, m)) || 0;
  calculator = createHydraulicCalculator({
    typeAccumulated: (c, y, m) => get(calculatorMaps.type, c, y, m),
    subtypeAccumulated: (c, y, m) => get(calculatorMaps.subtype, c, y, m),
    origin1Accumulated: (c, y, m) => get(calculatorMaps.origin1, c, y, m),
    origin2Accumulated: (c, y, m) => get(calculatorMaps.origin2, c, y, m)
  })
}

function monthlyMap(map, concept, y, m) {
  return (map.get(key(concept, y, m)) || 0) - (m === 1 ? 0 : (map.get(key(concept, y, m - 1)) || 0))
}

function monthlyConcept(concept, y, m) {
  return calculator.accumulated(concept, y, m) - (m === 1 ? 0 : calculator.accumulated(concept, y,
    m - 1))
}

function origin1(c, y, m) {
  return monthlyMap(calculatorMaps.origin1, c, y, m)
}

function origin2(c, y, m) {
  return monthlyMap(calculatorMaps.origin2, c, y, m)
}

function subtype(c, y, m) {
  return monthlyMap(calculatorMaps.subtype, c, y, m)
}

function subtypeDetail(subtypeName, candidates, y, m) {
  for (const candidate of candidates) {
    const composite = `${clean(subtypeName)}§${clean(candidate)}`;
    const fromOrigin2 = monthlyMap(calculatorMaps.subtypeOrigin2, composite, y, m);
    if (Math.abs(fromOrigin2) > 0.000001) return fromOrigin2;
    const fromOrigin1 = monthlyMap(calculatorMaps.subtypeOrigin1, composite, y, m);
    if (Math.abs(fromOrigin1) > 0.000001) return fromOrigin1;
  }
  return 0;
}

function buildDistribution() {
  distributionRules = new Map();
  let section = '';
  for (const row of data.distributionConfig) {
    const a = clean(row[0]),
      b = clean(row[1]),
      c = clean(row[2]),
      d = clean(row[3]);
    if (a && !b && !c && !d) {
      section = String(row[0]).trim();
      distributionRules.set(section, []);
      continue
    }
    if (!section || !a || a === 'COD_DISP' || d.startsWith('TOTAL')) continue;
    const factor = Number(parseSpanishNumber(row[3], NaN));
    if (Number.isFinite(factor)) distributionRules.get(section).push({
      device: a,
      factor
    })
  }
  balanceMonthDevice = new Map();
  for (const row of data.balance) {
    const date = excelDate(row[0]);
    if (!date) continue;
    const month = date.slice(0, 7),
      device = clean(row[1]);
    if (!balanceMonthDevice.has(month)) balanceMonthDevice.set(month, new Map());
    const values = balanceMonthDevice.get(month);
    values.set(device, (values.get(device) || 0) + n(row[6]))
  }
}

function populationValue(population, y, m) {
  const values = balanceMonthDevice.get(`${y}-${String(m).padStart(2,'0')}`),
    rules = distributionRules.get(population) || [];
  return !values ? 0 : rules.reduce((t, r) => t + (values.get(r.device) || 0) * r.factor, 0)
}

function buildPopulationIndex() {
  populationIndex = new Map();
  for (const row of data.populationRows) {
    const year = Number(parseSpanishNumber(row[0], NaN)),
      name = clean(row[1]),
      inhabitants = n(row[2]),
      code = String(row[3] || '').trim().toUpperCase();
    if (!Number.isFinite(year) || !name || !code) continue;
    populationIndex.set(`${year}|${code}|${name}`, (populationIndex.get(
      `${year}|${code}|${name}`) || 0) + inhabitants);
  }
}

function populationByName(name, consultationYear) {
  const populationYear = consultationYear - 1,
    target = clean(name);
  let total = 0;
  for (const [indexKey, value] of populationIndex) {
    const [yearText, _code, ...nameParts] = indexKey.split('|');
    if (Number(yearText) === populationYear && nameParts.join('|') === target) total += value;
  }
  return total;
}

function populationByNames(names, consultationYear) {
  for (const name of names) {
    const value = populationByName(name, consultationYear);
    if (value !== 0) return value;
  }
  return 0;
}

function distributedPopulationByName(name, consultationYear) {
  const normalized = clean(name);
  const aliases = {
    'LA PUEBLA DEL RIO': ['PUEBLA DEL RIO', 'LA PUEBLA DEL RIO'],
    'PUEBLA DEL RIO': ['PUEBLA DEL RIO', 'LA PUEBLA DEL RIO'],
  };
  return populationByNames(aliases[normalized] || [name], consultationYear);
}




const fmtPopulation = value => (Number(value || 0) / 1000).toLocaleString('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const populationMark = value => `(1) ${fmtPopulation(value)}`;
const dam3 = v => Number(v || 0) / 1000,
  fmt = v => dam3(v).toLocaleString('es-ES', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: true
  });

function row(concept, label, partial = '', total = '', cls = '') {
  return `<div class="row ${cls}"><span class="concept">${concept}</span><span class="label">${label}</span><span class="partial">${partial}</span><span class="total">${total}</span></div>`
}

function section(number, title, color, content) {
  return `<section class="section ${color}"><div class="section-title">${number}.- ${title}</div>${content}</section>`
}

function render() {
  const y = +document.getElementById('year').value,
    m = +document.getElementById('month').value,
    month = MONTHS[m - 1];
  writeFilterState(UI_STATE_KEYS.statistics4, {
    month: m,
    year: y
  });
  document.getElementById('statusDate').textContent = `${month} ${y}`;
  document.getElementById('reportPeriod').textContent = `${month} ${y}`;
  document.getElementById('yearBand').textContent = `AÑO ${y}`;
  document.getElementById('volumeBand').textContent =
    `Volúmenes mes de ${month.toLowerCase()} ${y} (dam³)`;
  const cc = {
      ...calculator.capturedComponents(y, m)
    },
    prev = m === 1 ? {} : calculator.capturedComponents(y, m - 1);
  for (const k of Object.keys(cc)) cc[k] -= prev[k] || 0;
  const raw = cc.minilla + cc.gergal + cc.calaElRonquillo + cc.melonares,
    imported = cc.emergenciaElPintado + cc.emergenciaRio,
    ground = cc.pozos,
    captured = monthlyConcept('captured', y, m),
    rawExported = monthlyConcept('rawExported', y, m),
    etapInput = monthlyConcept('etapInput', y, m),
    conveyed = monthlyConcept('conveyed', y, m),
    etapProduced = monthlyConcept('etapProduced', y, m),
    treatedImported = monthlyConcept('treatedImported', y, m),
    reservoir = monthlyConcept('reservoirBalance', y, m),
    treatedExported = monthlyConcept('treatedExported', y, m),
    distributed = monthlyConcept('distributed', y, m);
  const reservoirHead = subtypeDetail('BALANCE DEPÓSITOS', ['Cabecera (ETAP Carambolo)',
    'Cabecera ETAP Carambolo', 'Cabecera'
  ], y, m);
  const reservoirTail = origin2('Cola (Alcala)', y, m);
  const aljarafePopulation = populationByNames(['MUNICIPIOS ALJARAFESA', 'TOMA ALJARAFE',
    'TOMA ALJARAFESA'
  ], y);
  const guillenaPopulation = populationByNames(['GUILLENA-PAJANOSAS',
    'GUILLENA PAJANOSAS'
  ], y);
  const etapCaramboloPopulation = populationByNames(['ETAP CARAMBOLO (SEVILLA Y ZI)',
    'ETAP CARAMBOLO (SEVILLA Y Z.I.)'
  ], y);
  const garroboPopulation = populationByName('ETAP EL GARROBO', y);
  const ronquilloPopulation = populationByName('ETAP EL RONQUILLO', y);
  const conveyancePopulation = aljarafePopulation + guillenaPopulation + etapCaramboloPopulation +
    garroboPopulation + ronquilloPopulation;
  let html = '';
  html += section('1', 'AGUA CAPTADA', 'blue', row('1.1', 'AGUA BRUTA', '', fmt(raw), 'subhead') +
    row('', 'Minilla', fmt(cc.minilla), '', 'detail') + row('', 'Canal La Minilla', fmt(origin2(
      'Canal La Minilla', y, m)), '', 'detail') + row('', 'El Garrobo', fmt(origin2('El Garrobo',
      y, m)), '', 'detail') + row('', 'Gergal', fmt(cc.gergal), '', 'detail') + row('',
      'El Ronquillo (Cala)', fmt(cc.calaElRonquillo), '', 'detail') + row('', 'Melonares', fmt(cc
      .melonares), '', 'detail') + row('1.2', 'AGUA BRUTA IMPORTADA', '', fmt(imported),
      'subhead') + row('', 'Emergencias (El Pintado)', fmt(cc.emergenciaElPintado), '',
    'detail') + row('', 'Emergencias (Río)', fmt(cc.emergenciaRio), '', 'detail') + row('1.3',
      'AGUA SUBTERRÁNEA', '', fmt(ground), 'subhead') + row('', 'Pozos', fmt(ground), '',
      'detail'));
  html += section('2', 'AGUA ADUCIDA', 'green', row('2.1', 'AGUA BRUTA EXPORTADA', '', fmt(
    rawExported), 'subhead') + row(populationMark(aljarafePopulation), 'Toma Aljarafesa', fmt(
    origin2('Toma Aljarafesa', y, m)), '', 'detail population-row') + row(populationMark(
    guillenaPopulation), 'Guillena-Panajosas', fmt(origin2('Toma Guillena', y, m) + origin2(
    'Toma Panajosas', y, m)), '', 'detail population-row') + row('2.2', 'AGUA ENTRADA ETAP', '',
    fmt(etapInput), 'subhead') + row(populationMark(etapCaramboloPopulation),
    'ETAP Carambolo (Sevilla y ZI)', fmt(subtypeDetail('AGUA ENTRADA ETAP', [
      'ETAP Carambolo (Sevilla y ZI)', 'ETAP Carambolo (Sevilla y Z.I.)', 'ETAP Carambolo'
    ], y, m)), '', 'detail population-row') + row(populationMark(garroboPopulation),
    'ETAP El Garrobo', fmt(subtypeDetail('AGUA ENTRADA ETAP', ['ETAP El Garrobo', 'El Garrobo'],
      y, m)), '', 'detail population-row') + row(populationMark(ronquilloPopulation),
    'ETAP El Ronquillo', fmt(subtypeDetail('AGUA ENTRADA ETAP', ['ETAP El Ronquillo',
      'El Ronquillo'
    ], y, m)), '', 'detail population-row') + row(populationMark(conveyancePopulation), 'TOTAL',
    '', '', 'section-total population-total'));
  html += section('3', 'PROCEDENCIA AGUA SUMINISTRADA', 'gold', row('3.1',
    'AGUA PRODUCIDA EN LA ETAP', '', fmt(etapProduced), 'subhead') + row('',
    'ETAP Carambolo (Sevilla y Z.I.)', fmt(subtypeDetail('AGUA PRODUCIDA ETAP', [
      'ETAP Carambolo (Sevilla y ZI)', 'ETAP Carambolo (Sevilla y Z.I.)', 'ETAP Carambolo'
    ], y, m)), '', 'detail') + row('', 'ETAP El Garrobo', fmt(subtypeDetail(
    'AGUA PRODUCIDA ETAP', ['ETAP El Garrobo', 'El Garrobo'], y, m)), '', 'detail') + row('',
    'ETAP El Ronquillo', fmt(subtypeDetail('AGUA PRODUCIDA ETAP', ['ETAP El Ronquillo',
      'El Ronquillo'
    ], y, m)), '', 'detail') + row('3.2', 'AGUA TRATADA IMPORTADA', '', fmt(treatedImported),
    'subhead') + row('3.3', 'BALANCE EN DEPÓSITOS', '', fmt(reservoir), 'subhead') + row('',
    'Cabecera (ETAP Carambolo)', fmt(reservoirHead), '', 'detail') + row('',
    'Cola (Alcalá de Guadaíra)', fmt(reservoirTail), '', 'detail'));
  const sevillePopulation = populationByName('SEVILLA', y);
  let distributedPopulationTotal = sevillePopulation;
  let populations = row(populationMark(sevillePopulation), 'SEVILLA',
    `<span class="noted-value"><span class="note-marker">(2)</span><span>${fmt(distributed-[...distributionRules.keys()].reduce((t,p)=>t+populationValue(p,y,m),0))}</span></span>`,
    '', 'detail population-row');
  for (const p of distributionRules.keys()) {
    const inhabitants = distributedPopulationByName(p, y);
    distributedPopulationTotal += inhabitants;
    const populationLabel = p.replace(/\b\w/g, c => c.toUpperCase());
    const numericValue = fmt(populationValue(p, y, m));
    const displayedValue = clean(p) === 'SAN JUAN DE AZNALFARACHE' ?
      `<span class="noted-value"><span class="note-marker">(2)</span><span>${numericValue}</span></span>` :
      numericValue;
    populations += row(populationMark(inhabitants), populationLabel, displayedValue, '',
      'detail population-row');
  }
  html += section('4', 'REPARTO AGUA SUMINISTRADA', 'pink', row('4.1', 'AGUA TRATADA EXPORTADA', '',
    fmt(treatedExported), 'subhead') + row('', 'Huesna', fmt(origin2('Huesna', y, m)), '',
    'detail') + row('', 'Aljarafesa (Gelves)', fmt(origin2('Aljarafesa (Gelves)', y, m)), '',
    'detail') + row('', 'Burguillos', fmt(origin2('Burguillos', y, m)), '', 'detail') + row(
    '4.2', 'AGUA DISTRIBUIDA', '', fmt(distributed), 'subhead') + populations + row(
    populationMark(distributedPopulationTotal), 'TOTAL', fmt(distributed), '',
    'section-total population-total'));
  document.getElementById('reportBody').innerHTML = html;
  document.getElementById('reportDate').textContent = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date());
}
async function loadData() {
  const cached = await getCachedDataset(CACHE_KEY, {
    version: CACHE_VERSION,
    maxAgeMs: CACHE_AGE
  }).catch(() => null);
  if (cached) return cached;
  const s = GOOGLE_DATABASE.sheets,
    [red, balance, config, population] = await Promise.all([loadGoogleSheet(s.datosRed, 1),
      loadGoogleSheet(s.balancePoblaciones, 1), loadGoogleSheet(s.distribuidoPoblaciones, 0),
      loadGoogleSheet(s.chgPoblacion, 0)
    ]);
  const loaded = {
    red: sheetRows(red).slice(1),
    balance: sheetRows(balance).slice(1),
    distributionConfig: sheetRows(config),
    populationRows: sheetRows(population).slice(1)
  };
  setCachedDataset(CACHE_KEY, loaded, {
    version: CACHE_VERSION
  }).catch(() => {});
  return loaded
}
const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
async function refresh() {
  const panel = document.getElementById('updateProgress'),
    print = document.getElementById('print');
  panel.classList.add('is-visible');
  panel.setAttribute('aria-hidden', 'false');
  print.disabled = true;
  await paint();
  try {
    render()
  } finally {
    panel.classList.remove('is-visible');
    panel.setAttribute('aria-hidden', 'true');
    print.disabled = false
  }
}
async function init() {
    data = await loadData();
    buildCalculator();
    buildDistribution();
    buildPopulationIndex();
    const redDates = redRecords(data.red)
        .map(record => record.date)
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort(),
      fallbackDate = new Date(),
      minimumDate = redDates.at(0),
      maximumDate = redDates.at(-1),
      minimumYear = minimumDate
        ? Number(minimumDate.slice(0, 4))
        : fallbackDate.getFullYear(),
      maximumYear = maximumDate
        ? Number(maximumDate.slice(0, 4))
        : fallbackDate.getFullYear(),
      defaultMonth = maximumDate
        ? Number(maximumDate.slice(5, 7))
        : fallbackDate.getMonth() + 1,
      defaultYear = maximumYear,
      years = Array.from({
        length: Math.max(1, maximumYear - minimumYear + 1)
      }, (_, index) => minimumYear + index),
      saved = readFilterState(UI_STATE_KEYS.statistics4, {
        month: defaultMonth,
        year: defaultYear
      }),
      savedMonth = Number(saved.month),
      savedYear = Number(saved.year),
      selectedMonth = savedMonth >= 1 && savedMonth <= 12
        ? savedMonth
        : defaultMonth,
      selectedYear = years.includes(savedYear)
        ? savedYear
        : defaultYear,
      month = document.getElementById('month'),
      year = document.getElementById('year');
    month.innerHTML = MONTHS.map((x, i) => `<option value="${i+1}">${x}</option>`).join('');
    year.innerHTML = years.map(x => `<option value="${x}">${x}</option>`).join('');
    month.value = selectedMonth;
    year.value = selectedYear;
    document.getElementById('todayDate').textContent = new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }).format(new Date());
    render();
    document.getElementById('loading').style.display = 'none'
  }
  ['month', 'year'].forEach(id => document.getElementById(id).addEventListener('change', refresh));
document.getElementById('print').addEventListener('click', () => window.print());
init().catch(e => {
  console.error(e);
  const loading = document.getElementById('loading');
  loading.textContent = `No se pudieron cargar los datos: ${e.message}`;
  loading.style.display = 'grid'
});
