
import React, { useState, useMemo, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, LineChart, Line, ComposedChart, Area
} from 'recharts';
import { 
  TrendingUp, DollarSign, Activity, Settings, Info, 
  AlertTriangle, Save, RefreshCw, FileText, CheckCircle, FolderOpen, Trash2,
  LayoutDashboard, Zap, Gauge, Battery, Building2, BookOpen, ScrollText, Database
} from 'lucide-react';

type SectionKey =
  | 'overview'
  | 'spot'
  | 'frequency'
  | 'capacity'
  | 'lease'
  | 'rules'
  | 'policy'
  | 'basics';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

/**
 * 财务工具函数：计算IRR (内部收益率)
 * 使用牛顿迭代法
 */
function calculateIRR(cashFlows: number[], guess = 0.1): number {
  const maxIter = 1000;
  const precision = 1e-7;
  let rate = guess;

  for (let i = 0; i < maxIter; i++) {
    let npv = 0;
    let d_npv = 0;
    
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + rate, t);
      d_npv -= (t * cashFlows[t]) / Math.pow(1 + rate, t + 1);
    }

    if (Math.abs(npv) < precision) return rate;
    
    const newRate = rate - npv / d_npv;
    if (Math.abs(newRate - rate) < precision) return newRate;
    rate = newRate;
  }
  return rate;
}

/**
 * 财务工具函数：计算NPV (净现值)
 */
function calculateNPV(rate: number, cashFlows: number[]): number {
  return cashFlows.reduce((acc, val, t) => acc + val / Math.pow(1 + rate, t), 0);
}

// ----------------------------------------------------------------------
// 组件定义
// ----------------------------------------------------------------------

export default function ShandongStorageCalculator() {
  // --- 1. 输入参数状态 (默认值基于PDF报告基准情景) ---
  
  const [params, setParams] = useState({
    // 项目基础
    capacityMW: 200,       // MW
    systemDuration: 4,     // 系统时长 (小时) - 独立参数
    capacityMWh: 800,      // MWh = capacityMW * systemDuration
    lifeSpan: 15,          // 年
    runDays: 350,          // 天/年
    efficiency: 0.85,      // 综合效率
    dodDepth: 0.90,        // DOD充放深度
    degradation: 0.02,     // 年衰减率

    // 投资与融资
    epcPrice: 1.60,        // 元/Wh (PDF基准: 1.6, 调整后建议: 0.98~1.5)
    otherCostRatio: 0.05,  // 其他费用占比 (5%)
    debtRatio: 0.70,       // 贷款比例
    interestRate: 0.042,   // 贷款利率 (4.2%)
    loanTerm: 12,          // 贷款期限 (年)
    residualValue: 0.05,   // 残值率

    // 收益 - 现货套利
    cyclesPerDay: 2,       // 次/天
    spotSpread: 0.4509,    // 元/kWh (净价差)
    spotSpreadGrowth: 0.0, // 年增长率 (保守0)
    spotMarketUncertainty: 0.90, // 市场不确定性系数
    tradingLossFactor: 0.95,     // 交易损耗系数

    // 收益 - 容量补偿
    compStandard: 520000,  // 元/MW/年 (含税标准)
    kFactor: 2.0,          // K值 (小时)
    compPolicyCoeff: 0.65, // 政策调整系数 (PDF: 0.65)
    
    // 收益 - 容量租赁
    leasePrice: 250,       // 元/kW/年
    leaseRatio: 50,        // 出租率 (%)，例如 50 表示 50%
    
    // 收益 - 辅助服务(调频)
    auxIncome: 504,        // 万元/年 (直接输入估算值，因计算复杂)

    // 运营与税务
    opexRate: 0.02,        // 运维费率 (% of CAPEX)
    vatRate: 0.13,         // 增值税率 (销项) - 实际计算用综合税负简化
    vatRefundRatio: 0.50,  // 即征即退比例
    incomeTaxRate: 0.25,   // 企业所得税 (高新15%，基准25%)
    discountRate: 0.08,    // 基准折现率
  });

  // --- 2. 实时核心测算逻辑 ---

  const results = useMemo(() => {
    // A. 投资概算
    const totalInvestment = params.capacityMWh * 1000 * 1000 * params.epcPrice * (1 + params.otherCostRatio); // Total in Yuan
    const debtAmount = totalInvestment * params.debtRatio;
    const equityAmount = totalInvestment * (1 - params.debtRatio);

    // B. 逐年现金流计算
    const yearlyData = [];
    let accumulatedCashFlow = -equityAmount; // 累计现金流(资本金视角)
    
    // 现金流数组用于计算IRR
    const projectCashFlows = [-totalInvestment]; // 全投资CF
    const equityCashFlows = [-equityAmount];     // 资本金CF

    for (let year = 1; year <= params.lifeSpan; year++) {
      // 1. 物理参数
      // 电池实际可用容量衰减
      const degradFactor = Math.pow(1 - params.degradation, year - 1);
      const availableMWh = params.capacityMWh * degradFactor;
      
      // 2. 收入测算 (万元)
      
      // (1) 现货套利
      // 年放电量 (MWh) = 容量(衰减后) * DOD * 次数 * 天数 * 效率
      const annualDischargeMWh = availableMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency;
      // 价差按年复合增长 (spotSpreadGrowth 为小数, 如 0.02 表示 +2%/年)
      const yearSpread = params.spotSpread * Math.pow(1 + params.spotSpreadGrowth, year - 1);
      // 理论收入
      const theoreticalSpotIncome = (annualDischargeMWh * 1000 * yearSpread) / 10000; 
      // 修正后实际收入 (考虑不确定性 & 损耗)
      const spotIncome = theoreticalSpotIncome * params.spotMarketUncertainty * params.tradingLossFactor;

      // (2) 容量补偿
      // 依据用户图片公式重构:
      // 1. 确定储能的“可用容量” (Effective Capacity)
      //    U_可用 = (P_装机 * h_放电) / 24
      // 2. 计算年度容量补偿金额
      //    容量补偿(元/年) = U_可用 * 标准(52)
      
      // 计算有效容量 (MW) - 注意：不再除以2
      const effectiveCapacity = (params.capacityMW * params.kFactor) / 24; 
      
      // 计算年收入 (万元)
      // params.compStandard 单位是 元/MW/年，除以10000转为万元
      // 保留 compPolicyCoeff 作为政策调整系数(如0.65)，图片虽未提，但实务中必有考核或折扣
      const compIncome = effectiveCapacity * (params.compStandard / 10000) * params.compPolicyCoeff;

      // (3) 容量租赁
      // 年租赁收入(万元) = 装机容量(MW) × 出租率(%) ÷ 100 × 1000(kW/MW) × 租赁单价(元/kW·年) ÷ 10000
      const leaseIncome = (params.capacityMW * 1000 * (params.leaseRatio / 100) * params.leasePrice) / 10000;

      // (4) 辅助服务 (假设固定或微调)
      const auxIncome = params.auxIncome * degradFactor; // 随容量衰减

      const totalRevenue = spotIncome + compIncome + leaseIncome + auxIncome;

      // 3. 成本测算 (万元)
      const opex = (totalInvestment / 10000) * params.opexRate;
      
      // 折旧 (直线法, 残值5%)
      const depreciation = ((totalInvestment / 10000) * (1 - params.residualValue)) / params.lifeSpan;

      // 财务费用 (利息)
      // 等额本金简化计算
      const principalRepayment = year <= params.loanTerm ? (debtAmount / params.loanTerm) / 10000 : 0;
      const remainingDebt = year <= params.loanTerm 
        ? (debtAmount / 10000) - (principalRepayment * (year - 1)) 
        : 0;
      const interest = remainingDebt * params.interestRate;

      // 4. 税费
      // 简易增值税附加: 假设进项已抵扣完(运营期), 实际税负率按经验值 8.5% (含退税后)
      // PDF: "即征即退50%，实际税负8.5%"
      // 这里的Revenue是含税还是不含? PDF测算通常Revenue含税。
      // 假设 totalRevenue 含税。
      const vatTaxes = totalRevenue / 1.13 * 0.085; 
      const surcharges = vatTaxes * 0.12; // 附加税
      
      // 5. 利润
      // 利润总额 = 不含税收入 - 不含税成本 - 财务费用 - 附加税
      // 简化：EBITDA - 折旧 - 利息
      // 这里为了快速计算，采用：
      // 净收入(不含税)
      const revenueExclTax = totalRevenue / 1.13;
      const totalCostExclTax = opex + depreciation + interest + surcharges; // OPEX含不含税? 假设OPEX为不含税支出
      
      const profitBeforeTax = revenueExclTax - totalCostExclTax;
      const incomeTax = profitBeforeTax > 0 ? profitBeforeTax * params.incomeTaxRate : 0;
      const netProfit = profitBeforeTax - incomeTax;

      // 6. 现金流
      // 经营性现金流 (净利 + 折旧)
      const ocf = netProfit + depreciation; 
      
      // 全投资净现金流 (不含融资成本)
      // = EBIT * (1-Tax) + Depreciation - Capex(0) - ChangeInWorkingCapital
      // 简化: (RevenueExcl - Opex - Surcharges) * (1-Tax) + Depreciation * TaxRate ???
      // 采用标准定义: NCF = NetProfit + Interest*(1-Tax) + Depreciation
      const projectNCF = netProfit + interest * (1 - params.incomeTaxRate) + depreciation;
      
      // 资本金净现金流 (含融资成本, 扣除还本)
      const equityNCF = ocf - principalRepayment; // 已扣利息在NetProfit里

      accumulatedCashFlow += equityNCF * 10000; // 转回元

      projectCashFlows.push(projectNCF * 10000);
      equityCashFlows.push(equityNCF * 10000);

      yearlyData.push({
        year,
        revenue: totalRevenue,
        netProfit,
        projectNCF,
        equityNCF,
        cost: opex + interest + incomeTax,
        breakdown: {
          spot: spotIncome,
          comp: compIncome,
          lease: leaseIncome,
          aux: auxIncome
        }
      });
    }

    // 回收残值
    const terminalValue = (totalInvestment / 10000) * params.residualValue;
    projectCashFlows[params.lifeSpan] += terminalValue * 10000;
    equityCashFlows[params.lifeSpan] += terminalValue * 10000; // 假设债务已还清

    // C. 指标计算
    const projectIRR = calculateIRR(projectCashFlows);
    const equityIRR = calculateIRR(equityCashFlows);
    const npv = calculateNPV(params.discountRate, projectCashFlows);
    
    // 静态回收期
    let paybackPeriod = 0;
    let cumSum = -totalInvestment;
    for(let i=1; i<projectCashFlows.length; i++) {
      if (cumSum < 0) {
        cumSum += projectCashFlows[i];
        if (cumSum >= 0) {
          // 线性插值
          paybackPeriod = (i - 1) + (Math.abs(cumSum - projectCashFlows[i]) / projectCashFlows[i]);
          break;
        }
      }
    }

    return {
      totalInvestment,     // 元
      debtAmount,
      equityAmount,
      yearlyData,
      projectIRR,
      equityIRR,
      npv,
      paybackPeriod,
      avgRevenue: yearlyData.reduce((a, b) => a + b.revenue, 0) / params.lifeSpan,
      avgNetProfit: yearlyData.reduce((a, b) => a + b.netProfit, 0) / params.lifeSpan
    };
  }, [params]);

  /**
   * 计算基准年放电量（不考虑衰减，用于现货收入展示）
   */
  const annualDischargeMWh = useMemo(() => {
    return params.capacityMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency;
  }, [params.capacityMWh, params.dodDepth, params.cyclesPerDay, params.runDays, params.efficiency]);

  // --- 通知状态 ---
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showSavesPanel, setShowSavesPanel] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>('overview');

  const showNotification = useCallback((type: 'success' | 'error', msg: string) => {
    setNotification({ type, msg });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // --- 保存测算 ---
  const handleSaveCalculation = useCallback(() => {
    try {
      const timestamp = Date.now();
      const dateStr = new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const saveData = {
        id: timestamp,
        name: `测算 ${dateStr}`,
        params,
        summary: {
          projectIRR: results.projectIRR,
          equityIRR: results.equityIRR,
          npv: results.npv,
          paybackPeriod: results.paybackPeriod,
          totalInvestment: results.totalInvestment,
        },
      };
      const existing: typeof saveData[] = JSON.parse(localStorage.getItem('sd_storage_saves') || '[]');
      existing.unshift(saveData);
      localStorage.setItem('sd_storage_saves', JSON.stringify(existing.slice(0, 20)));
      showNotification('success', `已保存「${saveData.name}」`);
    } catch {
      showNotification('error', '保存失败，请重试');
    }
  }, [params, results, showNotification]);

  // --- 读取保存记录 ---
  const getSavedCalculations = () => {
    try {
      return JSON.parse(localStorage.getItem('sd_storage_saves') || '[]') as Array<{
        id: number; name: string; params: typeof params;
        summary: { projectIRR: number; equityIRR: number; npv: number; paybackPeriod: number; totalInvestment: number };
      }>;
    } catch { return []; }
  };

  const handleDeleteSave = (id: number) => {
    const saves = getSavedCalculations().filter(s => s.id !== id);
    localStorage.setItem('sd_storage_saves', JSON.stringify(saves));
    showNotification('success', '已删除');
    setShowSavesPanel(prev => prev); // trigger re-render
  };

  const handleLoadSave = (savedParams: typeof params) => {
    setParams(savedParams);
    setShowSavesPanel(false);
    showNotification('success', '已加载保存的测算参数');
  };

  // --- 导出报告 ---
  const handleExportReport = async () => {
    setIsExporting(true);
    try {
      const element = document.getElementById('main-report-content');
      if (!element) { showNotification('error', '未找到报告区域'); return; }

      // 等一帧，确保图表/字体已经渲染完成
      await new Promise(r => requestAnimationFrame(() => r(null)));
      if ((document as any).fonts?.ready) {
        try { await (document as any).fonts.ready; } catch {}
      }

      const canvas = await html2canvas(element, {
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#f9fafb',
        windowWidth: element.scrollWidth,
        windowHeight: element.scrollHeight,
        // 在克隆的 DOM 上去除 html2canvas 不支持的样式（backdrop-filter / 复杂渐变 / oklch 等）
        onclone: (doc) => {
          const root = doc.getElementById('main-report-content');
          if (!root) return;
          const all = root.querySelectorAll<HTMLElement>('*');
          all.forEach(el => {
            const cs = doc.defaultView?.getComputedStyle(el);
            if (!cs) return;
            // 1) 去掉 backdrop-filter
            el.style.backdropFilter = 'none';
            (el.style as any).webkitBackdropFilter = 'none';
            // 2) 复杂的多重渐变 / 不可解析颜色 → 退化为纯色背景
            const bg = cs.backgroundImage;
            if (bg && bg !== 'none' && (bg.includes('radial-gradient') || bg.includes('conic-gradient') || /oklch|lab\(|lch\(|color\(/.test(bg))) {
              el.style.backgroundImage = 'none';
              if (!cs.backgroundColor || cs.backgroundColor === 'rgba(0, 0, 0, 0)') {
                el.style.backgroundColor = '#0f172a';
              }
            }
            // 3) 兜底：替换不支持的现代颜色函数
            (['color','backgroundColor','borderColor'] as const).forEach(k => {
              const v = (cs as any)[k] as string;
              if (v && /oklch|lab\(|lch\(|color\(/.test(v)) {
                (el.style as any)[k] = k === 'color' ? '#0f172a' : '#ffffff';
              }
            });
          });
        },
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgH = (canvas.height * pageW) / canvas.width;
      let remainH = imgH;
      let yPos = 0;
      pdf.addImage(imgData, 'JPEG', 0, yPos, pageW, imgH);
      remainH -= pageH;
      while (remainH > 0) {
        yPos -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, yPos, pageW, imgH);
        remainH -= pageH;
      }
      const dateStr = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
      pdf.save(`山东储能测算报告_${dateStr}.pdf`);
      showNotification('success', 'PDF 报告已导出！');
    } catch (err) {
      console.error('[ExportPDF] 失败：', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('error', `导出失败：${msg.slice(0, 60)}`);
    } finally {
      setIsExporting(false);
    }
  };

  // --- 界面渲染辅助函数 ---
  const formatCurrency = (val: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(val);
  const formatPercent = (val: number) => (val * 100).toFixed(2) + '%';
  const formatNumber = (val: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(val);
  const firstYearRevenue = results.yearlyData[0]?.revenue ?? 0;
  const revenueStructure = [
    {
      label: '现货套利',
      shortLabel: '现货',
      value: results.yearlyData[0]?.breakdown.spot ?? 0,
      color: 'from-blue-500 to-cyan-400',
      glow: 'shadow-blue-500/20',
      accent: 'bg-blue-400',
      description: '价差套利 / 分时滚动交易',
    },
    {
      label: '容量补偿',
      shortLabel: '补偿',
      value: results.yearlyData[0]?.breakdown.comp ?? 0,
      color: 'from-violet-500 to-fuchsia-400',
      glow: 'shadow-violet-500/20',
      accent: 'bg-violet-400',
      description: '容量价值 / 政策补偿兑现',
    },
    {
      label: '容量租赁',
      shortLabel: '租赁',
      value: results.yearlyData[0]?.breakdown.lease ?? 0,
      color: 'from-emerald-500 to-lime-400',
      glow: 'shadow-emerald-500/20',
      accent: 'bg-emerald-400',
      description: '容量出租 / 长协收益锁定',
    },
    {
      label: '辅助服务',
      shortLabel: '辅助',
      value: results.yearlyData[0]?.breakdown.aux ?? 0,
      color: 'from-orange-500 to-amber-400',
      glow: 'shadow-orange-500/20',
      accent: 'bg-orange-400',
      description: '调频调峰 / AGC性能结算',
    },
  ].map(item => ({
    ...item,
    percent: firstYearRevenue > 0 ? (item.value / firstYearRevenue) * 100 : 0,
  }));

  // 输入控件封装
  const InputField = ({ label, value, onChange, unit, step = 0.01, tooltip }: any) => (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
          {label}
          {tooltip && (
            <div className="group relative flex justify-center">
              <Info size={12} className="text-gray-400 cursor-help" />
              <span className="absolute bottom-full mb-2 hidden w-48 p-2 text-xs text-white bg-gray-800 rounded group-hover:block z-10">
                {tooltip}
              </span>
            </div>
          )}
        </label>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full px-3 py-2 text-sm border rounded-md border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
      />
    </div>
  );

  const savedList = showSavesPanel ? getSavedCalculations() : [];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      {/* 全局通知 Toast */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl text-sm font-medium animate-in fade-in slide-in-from-top-2 ${
          notification.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
        }`}>
          {notification.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          {notification.msg}
        </div>
      )}

      {/* 已保存记录抽屉 */}
      {showSavesPanel && (
        <div className="fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowSavesPanel(false)} />
          <div className="relative ml-auto w-96 h-full bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="text-base font-bold text-gray-800">已保存的测算记录</h2>
              <button onClick={() => setShowSavesPanel(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {savedList.length === 0 ? (
                <p className="text-center text-gray-400 py-10 text-sm">暂无保存记录</p>
              ) : savedList.map(save => (
                <div key={save.id} className="border border-gray-100 rounded-lg p-3 hover:border-blue-200 hover:bg-blue-50 transition-colors">
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-sm font-medium text-gray-800">{save.name}</span>
                    <button onClick={() => handleDeleteSave(save.id)} className="text-gray-300 hover:text-red-400 ml-2">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs text-gray-500 mb-3">
                    <span>全投IRR: <span className="text-blue-600 font-semibold">{(save.summary.projectIRR * 100).toFixed(2)}%</span></span>
                    <span>资本金IRR: <span className="text-green-600 font-semibold">{(save.summary.equityIRR * 100).toFixed(2)}%</span></span>
                    <span>回收期: {save.summary.paybackPeriod.toFixed(1)} 年</span>
                    <span>NPV: {(save.summary.npv / 10000).toFixed(0)} 万</span>
                  </div>
                  <button
                    onClick={() => handleLoadSave(save.params)}
                    className="w-full py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-md hover:bg-blue-600 hover:text-white transition-colors"
                  >加载此方案</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 整体布局：左侧深色导航 + 右侧主内容 */}
      <div className="flex min-h-screen">

        {/* 侧边栏导航 */}
        <aside className="w-56 shrink-0 bg-slate-900 text-slate-200 flex flex-col sticky top-0 h-screen">
          <div className="px-5 py-5 border-b border-slate-800 flex items-center gap-3">
            <div className="bg-blue-600 rounded-lg w-10 h-10 flex items-center justify-center font-bold text-white">SX</div>
            <div className="leading-tight">
              <h1 className="text-sm font-bold">独立储能收益测算</h1>
              <p className="text-[11px] text-slate-400 mt-0.5">易储能源</p>
            </div>
          </div>
          <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
            {([
              { key: 'overview',  label: '收益总览', icon: LayoutDashboard },
              { key: 'spot',      label: '现货交易', icon: Zap },
              { key: 'frequency', label: '调频收益', icon: Gauge },
              { key: 'capacity',  label: '容量电价', icon: Battery },
              { key: 'lease',     label: '容量租赁', icon: Building2 },
              { key: 'rules',     label: '市场规则', icon: BookOpen },
              { key: 'policy',    label: '相关政策', icon: ScrollText },
              { key: 'basics',    label: '基础数据', icon: Database },
            ] as { key: SectionKey; label: string; icon: any }[]).map(item => {
              const Icon = item.icon;
              const active = activeSection === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveSection(item.key)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                    active ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500">
            v1.0 · 财务测算平台
          </div>
        </aside>

        {/* 主内容区 */}
        <div className="flex-1 flex flex-col bg-gray-50 min-w-0">

          {/* 顶部工具栏 */}
          <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-sm">
            <div className="px-6 lg:px-8 h-16 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900 tracking-tight">
                  {{
                    overview: '收益测算总览',
                    spot: '现货交易收益',
                    frequency: '调频(辅助服务)收益',
                    capacity: '容量电价补偿',
                    lease: '容量租赁收益',
                    rules: '市场规则',
                    policy: '相关政策',
                    basics: '基础数据与参数',
                  }[activeSection]}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">山东独立储能项目收益测算与运营分析</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSavesPanel(true)}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  <FolderOpen size={16} /> 历史记录
                </button>
                <button
                  onClick={handleExportReport}
                  disabled={isExporting}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isExporting ? <RefreshCw size={16} className="animate-spin" /> : <FileText size={16} />}
                  {isExporting ? '导出中...' : '导出报告'}
                </button>
                <button
                  onClick={handleSaveCalculation}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-sm"
                >
                  <Save size={16} /> 保存测算
                </button>
              </div>
            </div>
          </header>

          <main id="main-report-content" className="flex-1 px-6 lg:px-8 py-6 space-y-6">

            {/* ==================== 1. 收益总览 ==================== */}
            {activeSection === 'overview' && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">全投资 IRR</p>
                    <p className={`text-2xl font-bold mt-1 relative z-10 ${results.projectIRR > 0.08 ? 'text-blue-600' : 'text-red-500'}`}>
                      {formatPercent(results.projectIRR)}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">资本金IRR: <span className="text-gray-700 font-semibold">{formatPercent(results.equityIRR)}</span></p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-green-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">总投资额</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {(results.totalInvestment / 10000 / 10000).toFixed(2)} <span className="text-sm font-normal text-gray-500">亿元</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">单位投资: {params.epcPrice} 元/Wh</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-purple-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">静态回收期</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {results.paybackPeriod.toFixed(1)} <span className="text-sm font-normal text-gray-500">年</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">项目NPV: {(results.npv / 10000).toFixed(0)} 万元</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-orange-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">首年总收入</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {formatNumber(results.yearlyData[0].revenue)} <span className="text-sm font-normal text-gray-500">万元</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">净利润: {formatNumber(results.yearlyData[0].netProfit)} 万元</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-bold text-gray-800">全生命周期现金流分析</h3>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500"></span>当年净现金流</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500"></span>年收入</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-purple-400"></span>净利润</span>
                    </div>
                  </div>
                  <div className="h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={results.yearlyData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                        <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12, fill: '#666'}} />
                        <YAxis yAxisId="left" orientation="left" tickLine={false} axisLine={false} tick={{fontSize: 12, fill: '#666'}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                        <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} hide />
                        <RechartsTooltip 
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                          formatter={(value: number) => formatNumber(value)}
                        />
                        <Bar yAxisId="left" dataKey="projectNCF" fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={20} name="当年净现金流" />
                        <Line yAxisId="left" type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2} dot={false} name="年收入" />
                        <Area yAxisId="left" type="monotone" dataKey="netProfit" fill="#8b5cf6" stroke="#8b5cf6" fillOpacity={0.1} name="净利润" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-gray-800">首年收入构成</h3>
                      <span className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100">
                        合计 {formatNumber(results.yearlyData[0].revenue)} 万元
                      </span>
                    </div>
                    <div className="space-y-4">
                      {[
                        { label: '现货套利', value: results.yearlyData[0].breakdown.spot, color: 'bg-blue-500' },
                        { label: '容量补偿', value: results.yearlyData[0].breakdown.comp, color: 'bg-purple-500' },
                        { label: '容量租赁', value: results.yearlyData[0].breakdown.lease, color: 'bg-green-500' },
                        { label: '辅助服务', value: results.yearlyData[0].breakdown.aux, color: 'bg-orange-500' },
                      ].map((item, idx) => {
                        const total = results.yearlyData[0].revenue;
                        const percent = total > 0 ? (item.value / total) * 100 : 0;
                        return (
                          <div key={idx}>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="text-gray-600">{item.label}</span>
                              <span className="font-medium">{formatNumber(item.value)}万 ({percent.toFixed(1)}%)</span>
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-2">
                              <div className={`h-2 rounded-full ${item.color}`} style={{ width: `${percent}%` }}></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-lg font-bold text-gray-800 mb-4">财务指标校验</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">初始总投资 (CAPEX)</span>
                        <span className="font-mono">{(results.totalInvestment / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">自有资金 (Equity)</span>
                        <span className="font-mono text-blue-600">{(results.equityAmount / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">银行贷款 (Debt)</span>
                        <span className="font-mono">{(results.debtAmount / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">全生命周期总营收</span>
                        <span className="font-mono">{(results.yearlyData.reduce((a,b)=>a+b.revenue,0)).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">全生命周期总净利</span>
                        <span className="font-mono text-green-600">{(results.yearlyData.reduce((a,b)=>a+b.netProfit,0)).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between pt-2">
                        <span className="text-gray-500 font-medium">净现值 (NPV @{(params.discountRate*100).toFixed(0)}%)</span>
                        <span className="font-bold text-gray-800">{(results.npv / 10000).toFixed(0)} 万元</span>
                      </div>
                    </div>
                  </div>
                </div>

                <section className="relative overflow-hidden rounded-[28px] border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_24%),radial-gradient(circle_at_bottom_right,_rgba(124,58,237,0.16),_transparent_24%),linear-gradient(135deg,_#07111f_0%,_#0b1830_45%,_#111827_100%)] p-6 md:p-8 shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
                  <div className="pointer-events-none absolute inset-0 opacity-40">
                    <div className="absolute left-10 top-10 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl"></div>
                    <div className="absolute bottom-0 right-20 h-40 w-40 rounded-full bg-violet-500/10 blur-3xl"></div>
                    <div className="absolute inset-x-0 top-20 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent"></div>
                  </div>

                  <div className="relative mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">Revenue Structure Capsule</p>
                      <h3 className="mt-2 text-2xl font-bold text-white">收益结构科技舱</h3>
                      <p className="mt-2 max-w-2xl text-sm text-slate-300">
                        以首年收益为基准，将现货套利、容量补偿、容量租赁与辅助服务拆解为四条收益流。鼠标悬停卡片可查看收益强度与关键来源。
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-white/5 px-4 py-2 text-sm text-cyan-100 backdrop-blur-sm">
                      <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.9)]"></span>
                      首年总收益 {formatNumber(firstYearRevenue)} 万元
                    </div>
                  </div>

                  <div className="relative grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-stretch">
                    <div className="lg:col-span-6 space-y-5">
                      <div className="mx-auto grid w-full max-w-[560px] grid-cols-4 gap-3">
                        {revenueStructure.map(item => (
                          <div
                            key={item.label}
                            className={`group relative flex h-[92px] items-center justify-center rounded-[26px] border border-white/10 bg-white/8 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:scale-[1.03] hover:border-white/25`}
                          >
                            <div className={`absolute inset-0 rounded-[26px] bg-gradient-to-br ${item.color} opacity-20 blur-md transition-opacity duration-300 group-hover:opacity-40`}></div>
                            <div className="relative text-center">
                              <div className={`mx-auto mb-1.5 h-3 w-3 rounded-full ${item.accent} shadow-[0_0_12px_currentColor]`}></div>
                              <span className="block text-sm font-semibold text-slate-50">{item.shortLabel}</span>
                              <span className="mt-1 block text-xs font-medium text-slate-300">{item.percent.toFixed(1)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="relative mx-auto flex h-[360px] w-full max-w-[560px] items-center justify-center">
                        <div className="absolute inset-5 rounded-full border border-cyan-300/10"></div>
                        <div className="absolute inset-10 rounded-full border border-cyan-300/15 border-dashed animate-pulse"></div>
                        <div className="absolute inset-16 rounded-full border border-violet-300/10"></div>
                        <div className="absolute h-72 w-[22rem] rounded-[2.5rem] bg-[radial-gradient(circle,_rgba(34,211,238,0.35),_rgba(59,130,246,0.16)_45%,_rgba(15,23,42,0)_72%)] blur-sm"></div>
                        <div className="relative flex h-60 w-[25rem] flex-col items-center justify-center rounded-[2.25rem] border border-cyan-300/20 bg-slate-950/80 px-8 text-center shadow-[0_0_64px_rgba(34,211,238,0.24)] backdrop-blur-sm">
                          <span className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/70">Core Revenue</span>
                          <strong className="mt-4 whitespace-nowrap text-[3.6rem] font-semibold leading-none tracking-tight text-white">{formatNumber(firstYearRevenue)}</strong>
                          <span className="mt-2 text-sm text-slate-400">万元 / 首年</span>
                        </div>
                      </div>

                      <div className="mx-auto w-full max-w-[560px] rounded-[28px] border border-white/10 bg-slate-950/40 px-6 py-5 backdrop-blur-md shadow-[0_12px_40px_rgba(8,15,30,0.35)]">
                        <div className="mb-3 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300/70">Background Params</p>
                          <span className="text-[11px] text-slate-500">收益驱动口径</span>
                        </div>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-4 text-left text-[11px] text-slate-300 md:grid-cols-3">
                          <div>
                            <p className="text-slate-500">系统容量</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.capacityMWh)} MWh</p>
                          </div>
                          <div>
                            <p className="text-slate-500">日循环次数</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.cyclesPerDay)} 次/天</p>
                          </div>
                          <div>
                            <p className="text-slate-500">综合效率</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{(params.efficiency * 100).toFixed(1)}%</p>
                          </div>
                          <div>
                            <p className="text-slate-500">系统时长</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.systemDuration)} h</p>
                          </div>
                          <div>
                            <p className="text-slate-500">现货净价差</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{params.spotSpread.toFixed(4)} 元/kWh</p>
                          </div>
                          <div>
                            <p className="text-slate-500">DOD 深度</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{(params.dodDepth * 100).toFixed(1)}%</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="lg:col-span-6 grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2 md:auto-rows-fr lg:h-full">
                      {revenueStructure.map(item => (
                        <div
                          key={item.label}
                          className={`group relative min-h-[264px] overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/8 hover:shadow-2xl ${item.glow}`}
                        >
                          <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${item.color}`}></div>
                          <div className={`absolute -right-10 -top-10 h-24 w-24 rounded-full bg-gradient-to-br ${item.color} opacity-10 blur-2xl transition-opacity duration-300 group-hover:opacity-25`}></div>

                          <div className="relative flex items-start justify-between gap-3">
                            <div>
                              <p className="text-base font-semibold text-white">{item.label}</p>
                              <p className="mt-1 text-xs text-slate-400">{item.description}</p>
                            </div>
                            <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200">
                              收益流
                            </div>
                          </div>

                          <div className="relative mt-7 flex items-end justify-between gap-3">
                            <div>
                              <p className="text-2xl font-semibold text-white">{formatNumber(item.value)}</p>
                              <p className="mt-1 text-xs text-slate-400">万元 / 首年贡献</p>
                            </div>
                            <div className="text-right text-xs text-slate-400">
                              <p>收益强度</p>
                              <p className="mt-1 font-mono text-slate-200">{(item.percent / 100 * 360).toFixed(0)} deg</p>
                            </div>
                          </div>

                          <div className="mt-7">
                            <div className="mb-2 flex justify-between text-[11px] text-slate-400">
                              <span>贡献强度</span>
                              <span>{item.label}</span>
                            </div>
                            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className={`h-2 rounded-full bg-gradient-to-r ${item.color} transition-all duration-500 group-hover:brightness-110`}
                                style={{ width: `${Math.max(item.percent, 2)}%` }}
                              ></div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* ==================== 2. 现货交易 ==================== */}
            {activeSection === 'spot' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Zap size={16} className="text-blue-600" />
                    <h3 className="font-semibold text-gray-800">现货套利参数</h3>
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <InputField label="日循环次数" unit="次" value={params.cyclesPerDay} onChange={(v:any)=>setParams({...params, cyclesPerDay:v})} />
                      <InputField label="年运行天数" unit="天" value={params.runDays} onChange={(v:any)=>setParams({...params, runDays:v})} />
                    </div>
                    <InputField label="现货净价差" unit="元/kWh" step={0.0001} value={params.spotSpread} onChange={(v:any)=>setParams({...params, spotSpread:v})} tooltip="PDF基准: 0.4509" />
                    <InputField label="价差年增长率" unit="小数(0.02=2%)" step={0.001} value={params.spotSpreadGrowth} onChange={(v:any)=>setParams({...params, spotSpreadGrowth:v})} tooltip="按年复合增长，输入小数：0=持平，0.02 表示每年+2%。保守建议取 0" />
                    <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 mb-3 space-y-1">
                      <div className="flex justify-between"><span>当前值（{(params.spotSpreadGrowth*100).toFixed(1)}%/年）</span><span className="font-mono">第1年 {params.spotSpread.toFixed(4)} 元/kWh</span></div>
                      <div className="flex justify-between"><span>第 5 年价差</span><span className="font-mono">{(params.spotSpread * Math.pow(1+params.spotSpreadGrowth, 4)).toFixed(4)}</span></div>
                      <div className="flex justify-between"><span>第 {params.lifeSpan} 年价差</span><span className="font-mono">{(params.spotSpread * Math.pow(1+params.spotSpreadGrowth, params.lifeSpan-1)).toFixed(4)}</span></div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 bg-yellow-50 p-3 rounded-md border border-yellow-100">
                      <InputField label="市场不确定系数" unit="%" step={0.01} value={params.spotMarketUncertainty} onChange={(v:any)=>setParams({...params, spotMarketUncertainty:v})} tooltip="预测偏差修正 (默认0.9)" />
                      <InputField label="交易损耗系数" unit="%" step={0.01} value={params.tradingLossFactor} onChange={(v:any)=>setParams({...params, tradingLossFactor:v})} tooltip="调度/考核损耗 (默认0.95)" />
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">理论年放电量</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(annualDischargeMWh)} <span className="text-sm font-normal text-gray-500">MWh</span></p>
                      <p className="text-xs text-gray-400 mt-1">≈ {formatNumber(annualDischargeMWh / 10)} 万kWh</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年现货收入(修正后)</p>
                      <p className="text-xl font-bold text-blue-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.spot)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.spot / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年现货收入 (含衰减)</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.spot" fill="#3b82f6" radius={[4,4,0,0]} name="现货套利" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900 flex gap-2">
                    <Info size={16} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium mb-1">计算口径：</p>
                      <p>现货收入 = 装机容量(衰减后) × 日循环次数 × 年运行天数 × 综合效率 × 净价差 × 市场不确定系数 × 交易损耗系数。</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 3. 调频收益 ==================== */}
            {activeSection === 'frequency' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Gauge size={16} className="text-orange-600" />
                    <h3 className="font-semibold text-gray-800">调频(辅助服务)参数</h3>
                  </div>
                  <div className="p-4">
                    <InputField label="调频年收入估算" unit="万元" value={params.auxIncome} onChange={(v:any)=>setParams({...params, auxIncome:v})} tooltip="AGC调频净收益 (中标里程电量×单价×K_settle×D)" />
                    <div className="bg-yellow-50 border border-yellow-100 rounded-md p-3 text-xs text-yellow-900 mt-2">
                      调频收益受 AGC 调用频次、性能折算系数 D、Ksettle 影响较大，建议直接输入经验估算值。
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年调频收入</p>
                      <p className="text-xl font-bold text-orange-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.aux)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.aux / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">全周期调频累计</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(results.yearlyData.reduce((a,b)=>a+b.breakdown.aux,0))} <span className="text-sm font-normal text-gray-500">万元</span></p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年调频收入</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.aux" fill="#f97316" radius={[4,4,0,0]} name="调频收益" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 4. 容量电价 ==================== */}
            {activeSection === 'capacity' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Battery size={16} className="text-purple-600" />
                    <h3 className="font-semibold text-gray-800">容量补偿参数</h3>
                  </div>
                  <div className="p-4">
                    <div className="text-xs text-gray-500 flex items-start gap-1 mb-3">
                      <Info size={12} className="mt-0.5 shrink-0"/>
                      <span>当前系统时长 <strong>{params.systemDuration}h</strong>，容量 <strong>{params.capacityMWh.toFixed(1)} MWh</strong></span>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <InputField label="核定放电时长(h)" unit="h" step={0.1} value={params.kFactor} onChange={(v:any)=>setParams({...params, kFactor: Math.min(v, params.systemDuration)})} tooltip={`政策核定放电时长 h_放电，通常不超过系统时长 ${params.systemDuration}h`} />
                      <InputField label="政策调整系数" unit="-" value={params.compPolicyCoeff} onChange={(v:any)=>setParams({...params, compPolicyCoeff:v})} tooltip="考虑实际考核打折，默认0.65" />
                    </div>
                    <InputField label="火电基准补偿单价" unit="元/MW/年" value={params.compStandard} onChange={(v:any)=>setParams({...params, compStandard:v})} tooltip="图片示例: 52万元/MW·年" />
                    <div className="bg-purple-50 border border-purple-100 rounded-md p-3 text-xs text-purple-900 mt-2">
                      可用容量 ≈ <strong>{(params.capacityMW * params.kFactor / 24).toFixed(2)} MW</strong> = (装机功率 × 核定放电时长) ÷ 24
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年容量补偿</p>
                      <p className="text-xl font-bold text-purple-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.comp)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.comp / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">可用容量</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{(params.capacityMW * params.kFactor / 24).toFixed(2)} <span className="text-sm font-normal text-gray-500">MW</span></p>
                      <p className="text-xs text-gray-400 mt-1">基于核定 {params.kFactor}h 放电</p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年容量补偿</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.comp" fill="#a855f7" radius={[4,4,0,0]} name="容量补偿" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 5. 容量租赁 ==================== */}
            {activeSection === 'lease' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Building2 size={16} className="text-green-600" />
                    <h3 className="font-semibold text-gray-800">容量租赁参数</h3>
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <InputField label="租赁单价" unit="元/kW·年" value={params.leasePrice} onChange={(v:any)=>setParams({...params, leasePrice:v})} tooltip="容量租赁单价，示例：250 元/kW·年" />
                      <InputField label="出租率" unit="%" step={1} value={params.leaseRatio} onChange={(v:any)=>setParams({...params, leaseRatio:v})} tooltip="百分比口径，例如 50 表示 50% 出租" />
                    </div>
                    <div className="bg-green-50 border border-green-100 rounded-md p-3 text-xs text-green-900 mt-2">
                      年租赁收入 = 装机功率(kW) × 出租率 × 租赁单价
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年租赁收入</p>
                      <p className="text-xl font-bold text-green-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.lease)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.lease / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">出租容量</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{(params.capacityMW * params.leaseRatio / 100).toFixed(2)} <span className="text-sm font-normal text-gray-500">MW</span></p>
                      <p className="text-xs text-gray-400 mt-1">出租率 {params.leaseRatio}%</p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年租赁收入</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.lease" fill="#10b981" radius={[4,4,0,0]} name="容量租赁" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 6. 市场规则 ==================== */}
            {activeSection === 'rules' && (
              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 space-y-6">
                <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><BookOpen size={18} className="text-blue-600"/>山东电力现货 / 辅助服务市场规则摘要</h3>
                <ul className="space-y-3 text-sm text-gray-700 list-disc pl-5">
                  <li><strong>交易品种：</strong>日前现货、实时现货、二次调频(AGC)、备用、调峰等。</li>
                  <li><strong>报价时段：</strong>按 00:00–06:00、06:00–12:00、12:00–16:00、16:00–21:00、21:00–24:00 五个分时段申报。</li>
                  <li><strong>出清机制：</strong>排序价格 = 申报价 × 归一化历史性能，按排序结果出清并出清。</li>
                  <li><strong>结算公式：</strong>调频收益 = 实际调节深度 D × 性能折算值 Ksettle × 调节里程单价。</li>
                  <li><strong>储能补偿：</strong>独立储能可参与调峰、容量补偿，被授予容量价值。</li>
                  <li><strong>风险提示：</strong>容量电价无政策担保，公开规则与考核办法逐年调整，建议在投资评估中保留口径折让。</li>
                </ul>
              </div>
            )}

            {/* ==================== 7. 相关政策 ==================== */}
            {activeSection === 'policy' && (
              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 space-y-6">
                <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><ScrollText size={18} className="text-blue-600"/>相关政策梳理</h3>
                <div className="space-y-5 text-sm text-gray-700">
                  <div>
                    <p className="font-semibold text-gray-800 mb-1">国家层面</p>
                    <ul className="list-disc pl-5 space-y-1 text-gray-600">
                      <li>《关于加快推动新型储能发展的指导意见》(发改能源〔2022〕475号)</li>
                      <li>《关于加快建设新型电力系统的指导意见》</li>
                      <li>新型储能项目管理办法 — 独立储能可作为独立市场主体参与电力市场。</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-800 mb-1">山东省层面</p>
                    <ul className="list-disc pl-5 space-y-1 text-gray-600">
                      <li>《山东省电力现货市场交易规则》</li>
                      <li>《山东省电力辅助服务市场运营规则》</li>
                      <li>《关于支持新型储能产业发展的若干政策措施》— 含容量补偿、容量租赁、即征即退等。</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-800 mb-1">税收 / 金融</p>
                    <ul className="list-disc pl-5 space-y-1 text-gray-600">
                      <li>增值税即征即退 50% (绿色能源)。</li>
                      <li>高新技术企业所得税 15% / 一般 25%。</li>
                      <li>绿色信贷利率优惠区间约 3.8%–4.5%。</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 8. 基础数据 ==================== */}
            {activeSection === 'basics' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-6 space-y-4">
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <Settings size={16} className="text-blue-600" />
                      <h3 className="font-semibold text-gray-800">项目基础参数</h3>
                    </div>
                    <div className="p-4">
                      <div className="grid grid-cols-3 gap-3">
                        <InputField 
                          label="装机功率" 
                          unit="MW" 
                          value={params.capacityMW} 
                          onChange={(v:any)=>setParams({
                            ...params, 
                            capacityMW:v,
                            capacityMWh: +(v * params.systemDuration).toFixed(2)
                          })} 
                          tooltip="功率改变时，按当前时长同步重算容量(MWh)"
                        />
                        <InputField 
                          label="系统时长" 
                          unit="小时" 
                          step={0.1}
                          value={params.systemDuration} 
                          onChange={(v:number)=>setParams({
                            ...params, 
                            systemDuration:v,
                            capacityMWh: +(params.capacityMW * v).toFixed(2),
                            kFactor: Math.min(params.kFactor, v)
                          })} 
                          tooltip="独立参数：储能系统的额定放电时长 = 容量(MWh) / 功率(MW)"
                        />
                        <InputField 
                          label="装机容量" 
                          unit="MWh" 
                          step={1}
                          value={params.capacityMWh} 
                          onChange={(v:number)=>{
                            const newDuration = params.capacityMW > 0 ? +(v / params.capacityMW).toFixed(3) : params.systemDuration;
                            setParams({
                              ...params, 
                              capacityMWh:v,
                              systemDuration: newDuration,
                              kFactor: Math.min(params.kFactor, newDuration)
                            });
                          }} 
                          tooltip="= 装机功率 × 系统时长，可直接编辑(将反推时长)"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-4 mt-3">
                        <InputField label="综合效率" unit="%" step={0.01} value={params.efficiency} onChange={(v:any)=>setParams({...params, efficiency:v})} />
                        <InputField label="DOD充放深度" unit="%" step={0.01} value={params.dodDepth} onChange={(v:any)=>setParams({...params, dodDepth:v})} tooltip="单次循环可释放的容量比例，常用 0.85 ~ 0.95" />
                        <InputField label="运营年限" unit="年" value={params.lifeSpan} onChange={(v:any)=>setParams({...params, lifeSpan:v})} />
                      </div>
                      <InputField label="年容量衰减率" unit="%" step={0.001} value={params.degradation} onChange={(v:any)=>setParams({...params, degradation:v})} tooltip="影响全周期收入，默认2%" />
                      <InputField label="单位造价(EPC)" unit="元/Wh" step={0.01} value={params.epcPrice} onChange={(v:any)=>setParams({...params, epcPrice:v})} tooltip="建议输入 0.98 ~ 1.60" />
                      <InputField label="其他成本系数" unit="%" step={0.01} value={params.otherCostRatio} onChange={(v:any)=>setParams({...params, otherCostRatio:v})} tooltip="管理费、土地等" />
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-6 space-y-4">
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <DollarSign size={16} className="text-purple-600" />
                      <h3 className="font-semibold text-gray-800">融资与税务</h3>
                    </div>
                    <div className="p-4">
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="贷款比例" unit="%" step={0.01} value={params.debtRatio} onChange={(v:any)=>setParams({...params, debtRatio:v})} />
                        <InputField label="贷款利率" unit="%" step={0.001} value={params.interestRate} onChange={(v:any)=>setParams({...params, interestRate:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="贷款期限" unit="年" step={1} value={params.loanTerm} onChange={(v:any)=>setParams({...params, loanTerm:v})} />
                        <InputField label="残值率" unit="%" step={0.01} value={params.residualValue} onChange={(v:any)=>setParams({...params, residualValue:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="所得税率" unit="%" step={0.01} value={params.incomeTaxRate} onChange={(v:any)=>setParams({...params, incomeTaxRate:v})} />
                        <InputField label="折现率" unit="%" step={0.01} value={params.discountRate} onChange={(v:any)=>setParams({...params, discountRate:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="运维费率" unit="%/CAPEX" step={0.001} value={params.opexRate} onChange={(v:any)=>setParams({...params, opexRate:v})} />
                        <InputField label="增值税即征即退" unit="%" step={0.01} value={params.vatRefundRatio} onChange={(v:any)=>setParams({...params, vatRefundRatio:v})} />
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <Database size={16} className="text-green-600" />
                      <h3 className="font-semibold text-gray-800">投资概算 (实时)</h3>
                    </div>
                    <div className="p-4 space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-gray-500">总投资 (CAPEX)</span><span className="font-mono">{(results.totalInvestment / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">自有资金</span><span className="font-mono text-blue-600">{(results.equityAmount / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">银行贷款</span><span className="font-mono">{(results.debtAmount / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">单位投资</span><span className="font-mono">{params.epcPrice.toFixed(2)} 元/Wh</span></div>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </main>
        </div>
      </div>
    </div>
  );
}

