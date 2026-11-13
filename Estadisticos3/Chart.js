export const C = Object.freeze({
  distributed: '#0f4c81',
  billed: '#5a9f2f',
  anf: '#ef2b1f',
  anc: '#6b21a8'
});
export function statistics3Options() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    animation: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          usePointStyle: true,
          boxWidth: 9,
          padding: 14,
          font: {
            size: 10
          }
        }
      },
      tooltip: {
        callbacks: {
          label: c =>
            ` ${c.dataset.label}: ${Number(c.raw||0).toLocaleString('es-ES',{maximumFractionDigits:2})}`
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: '#e8edf3'
        },
        ticks: {
          color: '#65748a',
          font: {
            size: 9
          },
          maxRotation: 90,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12
        }
      },
      volume: {
        position: 'left',
        beginAtZero: true,
        grid: {
          color: '#edf1f5'
        },
        title: {
          display: true,
          text: 'Volumen (m³/día)',
          color: '#172033',
          font: {
            size: 10,
            weight: '700'
          }
        },
        ticks: {
          color: '#65748a',
          font: {
            size: 9
          },
          callback: v => Number(v).toLocaleString('es-ES')
        }
      },
      loss: {
        position: 'right',
        max: 1.4,
        grid: {
          drawOnChartArea: false
        },
        title: {
          display: true,
          text: 'm³/h/km',
          color: '#172033',
          font: {
            size: 10,
            weight: '700'
          }
        },
        ticks: {
          stepSize: .2,
          color: '#65748a',
          font: {
            size: 9
          },
          callback: v => Number(v).toLocaleString('es-ES', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })
        }
      }
    }
  }
}
