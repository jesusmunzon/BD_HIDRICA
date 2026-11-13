import {
  GOOGLE_DATABASE
} from '../js/config.js';
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
  loadGoogleSheet
} from '../js/google-sheets.js';
import {
  excelDate,
  norm,
  parseSpanishNumber
} from '../js/formats.js';
import {
  sheetRows
} from '../js/table-utils.js';
import {
  createHydraulicCalculator,
  calculateMonthlyPopulationHydraulics
} from '../js/hydraulic-calculations.js';
import {
  C,
  statistics3Options
} from './Chart.js';
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto',
    'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ],
  SPECIAL = {
    TOTAL: '__TOTAL__',
    NON_SEVILLE: '__NON_SEVILLE__',
    SEVILLE: '__SEVILLE__'
  },
  charts = {},
  DATA_CACHE_KEY = 'estadisticos3-hydraulic-data',
  DATA_CACHE_VERSION = 5,
  DATA_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let rows = {
    balance: [],
    acucon: [],
    carnf: [],
    aforos: [],
    length: [],
    distributionConfig: [],
    red: []
  },
  distributionRules = new Map,
  systemCalculator = null,
  indexes = {},
  refreshToken = 0;
const pointCache = new Map,
  n = v => Number(parseSpanishNumber(v, 0) || 0),
  clean = v => norm(v).replace(/\s+/g, ' ').trim(),
  isExcluded = p => clean(p).includes('NO COMPUTAN'),
  isSeville = p => clean(p) === 'SEVILLA',
  ym = (y, m) => `${y}-${String(m).padStart(2,'0')}`,
  parseYm = v => {
    const [y, m] = String(v).split('-').map(Number);
    return {
      year: y,
      month: m
    }
  },
  addMonths = (y, m, d) => {
    const x = new Date(Date.UTC(y, m - 1 + d, 1));
    return {
      year: x.getUTCFullYear(),
      month: x.getUTCMonth() + 1
    }
  },
  labelMonth = (y, m) => `${MONTHS[m-1].slice(0,3).toLowerCase()}-${String(y).slice(-2)}`,
  fullMonth = (y, m) => `${MONTHS[m-1]} ${y}`;

function redDateRange() {
  const dates = rows.red
    .map(row => dateParts(row[0]))
    .filter(Boolean)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  if (!dates.length) {
    return { minimum: null, maximum: null };
  }

  return {
    minimum: dates.at(0),
    maximum: dates.at(-1)
  };
}

function startMonthLimits(range) {
  if (!range.minimum || !range.maximum) {
    return { min: '', max: '' };
  }

  return {
    min: `${range.minimum.year}-01`,
    max: `${range.maximum.year - 4}-12`
  };
}

function clampStartMonth(value, limits) {
  const month = String(value || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return limits.min || limits.max;
  if (limits.min && month < limits.min) return limits.min;
  if (month > limits.max) return limits.max;
  return month;
}

function dateParts(v) {
  const d = excelDate(v);
  return d ? {
    iso: d,
    year: +d.slice(0, 4),
    month: +d.slice(5, 7)
  } : null
}

function addPopulation(map, p, v) {
  p = clean(p);
  if (!p || isExcluded(p)) return;
  map.set(p, (map.get(p) || 0) + n(v))
}

function buildMonthlyIndex(src, {
  dateIndex,
  populationIndex,
  valueIndex
}) {
  const r = new Map;
  src.forEach(row => {
    const d = dateParts(row[dateIndex]);
    if (!d) return;
    const k = ym(d.year, d.month);
    if (!r.has(k)) r.set(k, new Map);
    addPopulation(r.get(k), row[populationIndex], row[valueIndex])
  });
  return r
}

function buildExternalIndex(src, {
  dateIndex = 0,
  dataDateIndex = 1,
  populationIndex,
  valueIndex
}) {
  const r = new Map;
  src.forEach(row => {
    const d = dateParts(row[dateIndex]),
      dd = dateParts(row[dataDateIndex]);
    if (!d || !dd) return;
    const k = ym(d.year, d.month);
    if (!r.has(k)) r.set(k, new Map);
    const s = r.get(k);
    if (!s.has(dd.iso)) s.set(dd.iso, new Map);
    addPopulation(s.get(dd.iso), row[populationIndex], row[valueIndex])
  });
  return r
}

function sumOption(map, o) {
  if (!map) return 0;
  if (o === SPECIAL.TOTAL) return [...map.values()].reduce((a, b) => a + b, 0);
  if (o === SPECIAL.NON_SEVILLE) return [...map].reduce((s, [p, v]) => s + (isSeville(p) ? 0 : v),
    0);
  if (o === SPECIAL.SEVILLE) return map.get('SEVILLA') || 0;
  return map.get(clean(o)) || 0
}
const monthlyIndexed = (i, y, m, o) => sumOption(i.get(ym(y, m)), o);

function monthlyExternal(i, y, m, o) {
  const s = i.get(ym(y, m));
  if (!s?.size) return 0;
  return sumOption(s.get([...s.keys()].sort().at(-1)), o)
}

function redRecords(src) {
  return src.map(r => ({
    date: excelDate(r[0]),
    type: String(r[2] || ''),
    subtype: String(r[3] || ''),
    origin1: String(r[4] || ''),
    origin2: String(r[5] || ''),
    value: n(r[7])
  })).filter(r => r.date)
}

function cumulativeIndex(records, prop) {
  const monthly = new Map,
    out = new Map,
    concepts = new Set,
    years = new Set;
  records.forEach(r => {
    const y = +r.date.slice(0, 4),
      m = +r.date.slice(5, 7),
      c = clean(r[prop]);
    monthly.set(`${c}|${y}|${m}`, (monthly.get(`${c}|${y}|${m}`) || 0) + r.value);
    concepts.add(c);
    years.add(y)
  });
  concepts.forEach(c => years.forEach(y => {
    let a = 0;
    for (let m = 1; m <= 12; m++) {
      a += monthly.get(`${c}|${y}|${m}`) || 0;
      out.set(`${c}|${y}|${m}`, a)
    }
  }));
  return out
}

function buildSystemCalculator() {
  const r = redRecords(rows.red),
    maps = {
      type: cumulativeIndex(r, 'type'),
      subtype: cumulativeIndex(r, 'subtype'),
      origin1: cumulativeIndex(r, 'origin1'),
      origin2: cumulativeIndex(r, 'origin2')
    },
    get = (i, c, y, m) => i.get(`${clean(c)}|${y}|${m}`) || 0;
  systemCalculator = createHydraulicCalculator({
    typeAccumulated: (c, y, m) => get(maps.type, c, y, m),
    subtypeAccumulated: (c, y, m) => get(maps.subtype, c, y, m),
    origin1Accumulated: (c, y, m) => get(maps.origin1, c, y, m),
    origin2Accumulated: (c, y, m) => get(maps.origin2, c, y, m)
  })
}

function monthlySystemDistributed(y, m) {
  return systemCalculator.accumulated('distributed', y, m) - (m === 1 ? 0 : systemCalculator
    .accumulated('distributed', y, m - 1))
}

function configuredPopulationName(v) {
  v = clean(v);
  return {
    'ALCALA DE GUADAIRA': 'ALCALÁ DE GUADAIRA',

    'PUEBLA DEL RIO': 'LA PUEBLA DEL RÍO',
    'PUEBLA DEL RÍO': 'LA PUEBLA DEL RÍO',
    'LA PUEBLA DEL RIO': 'LA PUEBLA DEL RÍO',
    'LA PUEBLA DEL RÍO': 'LA PUEBLA DEL RÍO',

    'CORIA DEL RIO': 'CORIA DEL RÍO'
  }[v] || v;
}

function buildDistributionRules() {
  distributionRules = new Map();

  let currentBlock = '';

  /*
   * Igual que Estadísticos 1:
   * las dos primeras filas son cabeceras o estructura.
   */
  for (
    let rowIndex = 2;
    rowIndex < rows.distributionConfig.length;
    rowIndex += 1
  ) {
    const row =
      rows.distributionConfig[rowIndex] || [];

    const code = clean(row[0]);
    const name = clean(row[1]);
    const population = clean(row[2]);
    const factorText = clean(row[3]);

    /*
     * Una fila con contenido únicamente en la primera
     * columna abre un bloque de población.
     */
    if (
      code &&
      !name &&
      !population &&
      !factorText
    ) {
      currentBlock =
        configuredPopulationName(code);

      distributionRules.set(
        currentBlock,
        []
      );

      continue;
    }

    if (code === 'COD_DISP') continue;
    if (factorText.startsWith('TOTAL')) continue;
    if (!currentBlock) continue;

    const factor = Number(
      parseSpanishNumber(
        row[3],
        Number.NaN
      )
    );

    /*
     * Excepción copiada de Estadísticos 1.
     * Burguillos se obtiene desde BD_Datos_Red.
     */
    const isBurguillos =
      name === 'ATE BURGUILLOS' &&
      population === 'BURGUILLOS';

    if (
      (code || isBurguillos) &&
      [-1, 0, 1].includes(factor)
    ) {
      distributionRules
        .get(currentBlock)
        .push({
          device: code,
          population,
          factor,
          isBurguillos
        });
    }
  }
}

function buildBalanceDeviceIndex() {
  const byDevice = new Map, byPopulation = new Map;
  rows.balance.forEach(row => {
    const d = dateParts(row[0]);
    if (!d) return;
    const k = ym(d.year, d.month);
    if (!byDevice.has(k)) byDevice.set(k, new Map);
    if (!byPopulation.has(k)) byPopulation.set(k, new Map);
    const deviceValues = byDevice.get(k),
      populationValues = byPopulation.get(k),
      device = clean(row[1]),
      population = configuredPopulationName(row[3]),
      value = n(row[6]);
    if (device) deviceValues.set(device, (deviceValues.get(device) || 0) + value);
    if (population && !isExcluded(population)) {
      populationValues.set(population, (populationValues.get(population) || 0) + value)
    }
  });
  return { byDevice, byPopulation }
}

function buildRedOriginMonthlyIndex() {
  const result = new Map();

  rows.red.forEach(row => {
    const date = dateParts(row[0]);

    if (!date) return;

    const origin = clean(row[4]);

    if (!origin) return;

    const key =
      `${origin}|${ym(
        date.year,
        date.month
      )}`;

    result.set(
      key,
      (result.get(key) || 0) +
        n(row[7])
    );
  });

  return result;
}

function monthlyRedOriginValue(
  origin,
  year,
  month
) {
  const key =
    `${clean(origin)}|${ym(
      year,
      month
    )}`;

  return (
    indexes.redOriginByMonth.get(key) || 0
  );
}

function monthlyConfiguredDistributed(
  year,
  month,
  populationName
) {
  const population =
    configuredPopulationName(
      populationName
    );

  const rules =
    distributionRules.get(population);

  if (!rules?.length) {
    return 0;
  }

  const deviceValues =
    indexes.balanceByMonthDevice.get(
      ym(year, month)
    );

  /*
   * El CMES de BD_Balance_Pobla ya es mensual.
   * No hay que acumularlo ni restar el mes anterior.
   */
  return rules.reduce(
    (total, rule) => {
      const sourceValue =
        rule.isBurguillos
          ? monthlyRedOriginValue(
              rule.population,
              year,
              month
            )
          : (
              deviceValues?.get(
                clean(rule.device)
              ) || 0
            );

      return (
        total +
        sourceValue * rule.factor
      );
    },
    0
  );
}

function monthlyPopulationTotals(
  year,
  month
) {
  const totals = new Map();

  for (
    const population
    of distributionRules.keys()
  ) {
    totals.set(
      population,
      monthlyConfiguredDistributed(
        year,
        month,
        population
      )
    );
  }

  return totals;
}

function monthlyPopulationDistributed(
  year,
  month,
  option,
  billedValue
) {
  const distributed =
    monthlySystemDistributed(
      year,
      month
    );

  const populationTotals =
    monthlyPopulationTotals(
      year,
      month
    );

  const populations =
    [...populationTotals.values()]
      .reduce(
        (total, value) =>
          total + Number(value || 0),
        0
      );

  if (option === SPECIAL.TOTAL) {
    return distributed;
  }

  if (
    option === SPECIAL.NON_SEVILLE
  ) {
    return populations;
  }

  if (option === SPECIAL.SEVILLE) {
    return distributed - populations;
  }

  const population =
    configuredPopulationName(option);

  /*
   * Dos Hermanas y las demás poblaciones
   * salen del bloque correspondiente de
   * CFG_Distribuido_Poblaciones.
   */
  if (
    populationTotals.has(population)
  ) {
    return (
      populationTotals.get(population) ||
      0
    );
  }

  /*
   * Torrepalma puede mantenerse como
   * consulta individual, pero no se suma
   * a TOTAL POBLACIONES. Ya está integrada
   * en La Rinconada.
   */
  if (
    clean(option) ===
    'URB. TORREPALMA (CARMONA)'
  ) {
    return billedValue;
  }

  return 0;
}

function buildIndexes() {
  const balanceIndexes =
    buildBalanceDeviceIndex();

  indexes = {
    balanceByMonthDevice:
      balanceIndexes.byDevice,

    balanceByMonthPopulation:
      balanceIndexes.byPopulation,

    redOriginByMonth:
      buildRedOriginMonthlyIndex(),

    billed: buildExternalIndex(
      rows.acucon,
      {
        populationIndex: 2,
        valueIndex: 16
      }
    ),

    registeredUnbilled:
      buildExternalIndex(
        rows.carnf,
        {
          populationIndex: 3,
          valueIndex: 8
        }
      ),

    unregisteredBilled:
      buildExternalIndex(
        rows.aforos,
        {
          populationIndex: 3,
          valueIndex: 4
        }
      ),

    length: buildMonthlyIndex(
      rows.length,
      {
        dateIndex: 0,
        populationIndex: 2,
        valueIndex: 3
      }
    )
  };
}

function point(y, m, o) {
  const k = `${y}|${m}|${o}`;
  if (pointCache.has(k)) return pointCache.get(k);
  const b = monthlyExternal(indexes.billed, y, m, o),
    r = calculateMonthlyPopulationHydraulics({
      year: y,
      month: m,
      distributedMonthly: monthlyPopulationDistributed(y, m, o, b),
      registeredBilledMonthly: b,
      registeredUnbilledMonthly: monthlyExternal(indexes.registeredUnbilled, y, m, o),
      unregisteredBilledMonthly: monthlyExternal(indexes.unregisteredBilled, y, m, o),
      networkLengthKm: monthlyIndexed(indexes.length, y, m, o)
    });
  pointCache.set(k, r);
  return r
}

function period(s) {
  return Array.from({
    length: 60
  }, (_, i) => addMonths(s.year, s.month, i))
}

function datasets(a) {
  return [{
    label: 'Vm diario DISTRIBUIDO (m³/día)',
    data: a.map(x => x.distributedDaily),
    borderColor: C.distributed,
    backgroundColor: C.distributed,
    yAxisID: 'volume',
    pointRadius: 2,
    borderWidth: 1.5,
    tension: .15
  }, {
    label: 'Vm diario FACTURADO (m³/día)',
    data: a.map(x => x.billedDaily),
    borderColor: C.billed,
    backgroundColor: C.billed,
    yAxisID: 'volume',
    pointRadius: 2,
    borderWidth: 1.5,
    tension: .15
  }, {
    label: 'ANF (m³/h/km)',
    data: a.map(x => x.anf),
    borderColor: C.anf,
    backgroundColor: C.anf,
    yAxisID: 'loss',
    pointRadius: 2,
    borderWidth: 1.5,
    tension: .08
  }, {
    label: 'ANC (m³/h/km)',
    data: a.map(x => x.anc),
    borderColor: C.anc,
    backgroundColor: C.anc,
    yAxisID: 'loss',
    pointRadius: 2,
    borderWidth: 1.5,
    tension: .08
  }]
}

function draw(id, a) {
  const d = {
    labels: a.map(x => labelMonth(x.year, x.month)),
    datasets: datasets(a)
  };
  if (charts[id]) {
    charts[id].data = d;
    charts[id].update('none')
  } else charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: d,
    options: statistics3Options()
  })
}
const displayName = v => v === SPECIAL.TOTAL ? 'TOTAL' : v === SPECIAL.NON_SEVILLE ?
  'TOTAL POBLACIONES' : v === SPECIAL.SEVILLE ? 'SEVILLA' : v;
const waitPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

function showProgress() {
  const p = document.getElementById('updateProgress');
  p?.classList.add('is-visible');
  p?.setAttribute('aria-hidden', 'false')
}

function hideProgress() {
  const p = document.getElementById('updateProgress');
  p?.classList.remove('is-visible');
  p?.setAttribute('aria-hidden', 'true')
}
async function render({
  showFeedback = true
} = {}) {
  const token = ++refreshToken,
    print = document.getElementById('print');
  if (showFeedback) {
    showProgress();
    if (print) print.disabled = true;
    await waitPaint()
  }
  try {
    if (token !== refreshToken) return;
    const selected = document.getElementById('population').value,
      start = parseYm(document.getElementById('startMonth').value),
      end = addMonths(start.year, start.month, 59),
      periods = period(start);
    document.getElementById('endMonth').value = ym(end.year, end.month);
    document.getElementById('selectedTitle').textContent = displayName(selected);
    draw('selectedChart', periods.map(p => point(p.year, p.month, selected)));
    draw('populationsChart', periods.map(p => point(p.year, p.month, SPECIAL.NON_SEVILLE)));
    draw('sevilleChart', periods.map(p => point(p.year, p.month, SPECIAL.SEVILLE)));
    draw('totalChart', periods.map(p => point(p.year, p.month, SPECIAL.TOTAL)));
    document.getElementById('consultationStatusValue').innerHTML =
      `<span class="status-field-label">Población:</span> <strong class="status-field-value">${displayName(selected)}</strong><span class="status-separator">-</span><span class="status-field-label">Desde:</span> <strong class="status-field-value">${fullMonth(start.year,start.month)}</strong><span class="status-separator">-</span><span class="status-field-label">Hasta:</span> <strong class="status-field-value">${fullMonth(end.year,end.month)}</strong>`
  } finally {
    document.getElementById('loading').style.display = 'none';
    if (showFeedback) {
      if (print) print.disabled = false;
      hideProgress()
    }
  }
}

function populateOptions() {
  const src = [...rows.balance.map(r => r[3]), ...rows.acucon.map(r => r[2]), ...rows.carnf.map(r =>
      r[3]), ...rows.aforos.map(r => r[3]), ...rows.length.map(r => r[2])],
    bad = new Set(['#N/A', 'AFOROS FACTURADOS (BASTONES)', 'AFOROS NO FACTURADOS', 'TOTAL', 'TORREPALMA']),
    names = [...new Map(src.map(v => String(v || '').trim()).filter(p => p && !isExcluded(p) && !
      isSeville(p)).filter(p => !bad.has(clean(p)) && !clean(p).includes(
      'POBLACIONES RESTANDO SEVILLA')).map(p => [clean(p), p])).values()].sort((a, b) => a
      .localeCompare(b, 'es')),
    select = document.getElementById('population');
  select.innerHTML = names.map(p => `<option value="${p}">${p}</option>`).join('');
  return names
}
async function loadSourceRows() {
  const cached = await getCachedDataset(DATA_CACHE_KEY, {
    version: DATA_CACHE_VERSION,
    maxAgeMs: DATA_CACHE_TTL_MS
  }).catch(() => null);
  if (cached) return cached;
  const s = GOOGLE_DATABASE.sheets;

  const [
    balance,
    acucon,
    carnf,
    aforos,
    length,
    distributionConfig,
    red
  ] = await Promise.all([
    loadGoogleSheet(
      s.balancePoblaciones,
      1
    ),

    loadGoogleSheet(
      s.datosAcucon,
      0
    ),

    loadGoogleSheet(
      s.datosCarnf,
      0
    ),

    loadGoogleSheet(
      s.datosAforosPerdidas,
      0
    ),

    loadGoogleSheet(
      s.longitudRed,
      0
    ),

    loadGoogleSheet(
      s.distribuidoPoblaciones,
      0
    ),

    loadGoogleSheet(
      s.datosRed,
      1
    )
  ]);
  const loaded = {
    balance: sheetRows(balance).slice(1),
    acucon: sheetRows(acucon).slice(1),
    carnf: sheetRows(carnf).slice(1),
    aforos: sheetRows(aforos).slice(1),
    length: sheetRows(length).slice(1),
    distributionConfig: sheetRows(distributionConfig),
    red: sheetRows(red).slice(1)
  };
  setCachedDataset(DATA_CACHE_KEY, loaded, {
    version: DATA_CACHE_VERSION
  }).catch(() => {});
  return loaded
}
async function init() {
  rows = await loadSourceRows();
  pointCache.clear();
  buildDistributionRules();
  buildSystemCalculator();
  buildIndexes();
  const names = populateOptions(),
    range = redDateRange();
  if (!range.minimum || !range.maximum) {
    throw new Error('BD_Datos_Red no contiene fechas válidas para configurar DESDE y HASTA.');
  }

  // HASTA se inicia en el mes y año de la fecha máxima de BD_Datos_Red.
  // Como la serie comprende 60 meses, DESDE se sitúa 59 meses antes.
  const initialStart = addMonths(
    range.maximum.year,
    range.maximum.month,
    -59
  );
  const defaultStartMonth = ym(initialStart.year, initialStart.month);
  const saved = readFilterState(UI_STATE_KEYS.statistics3, {
      population: 'DOS HERMANAS',
      startMonth: defaultStartMonth
    }),
    select = document.getElementById('population');
  select.value = names.includes(saved.population) ? saved.population : (names.find(p => clean(
    p) === 'DOS HERMANAS') || names[0] || '');
  const startMonthInput = document.getElementById('startMonth'),
    limits = startMonthLimits(range);
  if (limits.min) startMonthInput.min = limits.min;
  startMonthInput.max = limits.max;
  startMonthInput.value = clampStartMonth(
    saved.startMonth || defaultStartMonth,
    limits
  );
  document.getElementById('todayDate').textContent = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(new Date);
  await render({
    showFeedback: false
  })
}
let frame = 0;

function schedule() {
  writeFilterState(UI_STATE_KEYS.statistics3, {
    population: document.getElementById('population').value,
    startMonth: document.getElementById('startMonth').value
  });
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => render())
} ['population', 'startMonth'].forEach(id => document.getElementById(id).addEventListener('change',
  schedule));
function refreshChartsForPrint() {
  Object.values(charts).forEach((chartInstance) => {
    if (!chartInstance) return;
    chartInstance.resize();
    chartInstance.update('none');
  });
}

window.addEventListener('beforeprint', refreshChartsForPrint);
window.addEventListener('afterprint', () => {
  requestAnimationFrame(refreshChartsForPrint);
});

document.getElementById('print').addEventListener('click', () => {
  requestAnimationFrame(() => {
    refreshChartsForPrint();
    requestAnimationFrame(() => window.print());
  });
});
init().catch(e => {
  console.error(e);
  document.getElementById('loading').textContent =
    `No se pudieron cargar los datos: ${e.message}`
});
