
import React, { useState, useMemo, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, LineChart, Line, ComposedChart, Area
} from 'recharts';
import { 
  TrendingUp, DollarSign, Activity, Settings, Info, 
  AlertTriangle, Save, RefreshCw, FileText, CheckCircle, FolderOpen, Trash2
} from 'lucide-react';
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
    capacityMWh: 800,      // MWh
    systemDuration: 4,     // 系统时长 (小时) - 新增参数
    lifeSpan: 15,          // 年
    runDays: 350,          // 天/年
    efficiency: 0.85,      // 综合效率
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
      // 年放电量 (MWh) = 容量(衰减后) * 次数 * 天数 * 效率
      const annualDischargeMWh = availableMWh * params.cyclesPerDay * params.runDays * params.efficiency;
      // 理论收入
      const theoreticalSpotIncome = (annualDischargeMWh * 1000 * params.spotSpread) / 10000; 
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
    return params.capacityMWh * params.cyclesPerDay * params.runDays * params.efficiency;
  }, [params.capacityMWh, params.cyclesPerDay, params.runDays, params.efficiency]);

  // --- 通知状态 ---
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showSavesPanel, setShowSavesPanel] = useState(false);

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
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#f9fafb',
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
    } catch {
      showNotification('error', '导出失败，请重试');
    } finally {
      setIsExporting(false);
    }
  };

  // --- 界面渲染辅助函数 ---
  const formatCurrency = (val: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(val);
  const formatPercent = (val: number) => (val * 100).toFixed(2) + '%';
  const formatNumber = (val: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(val);

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

      {/* 顶部导航 */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Activity className="text-white h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900 tracking-tight">山东储能收益测算模型</h1>
              <p className="text-xs text-gray-500">基于2025年政策 | 财务总监版</p>
            </div>
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

      <main id="main-report-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* 左侧：参数输入区 */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* 1. 基础参数 */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <Settings size={16} className="text-blue-600" />
                <h3 className="font-semibold text-gray-800">1. 项目基础参数</h3>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 gap-4">
                  <InputField 
                    label="装机功率" 
                    unit="MW" 
                    value={params.capacityMW} 
                    onChange={(v:any)=>setParams({
                      ...params, 
                      capacityMW:v,
                      capacityMWh: v * params.systemDuration // 保持时长不变，重算MWh
                    })} 
                  />
                  <div className="opacity-50 pointer-events-none">
                    <InputField label="装机容量" unit="MWh" value={params.capacityMWh} onChange={()=>{}} tooltip="由功率 x 时长自动计算" />
                  </div>
                  <InputField label="综合效率" unit="%" step={0.01} value={params.efficiency} onChange={(v:any)=>setParams({...params, efficiency:v})} />
                  <InputField label="运营年限" unit="年" value={params.lifeSpan} onChange={(v:any)=>setParams({...params, lifeSpan:v})} />
                </div>
                <InputField label="年容量衰减率" unit="%" step={0.001} value={params.degradation} onChange={(v:any)=>setParams({...params, degradation:v})} tooltip="影响全周期收入，默认2%" />
                <InputField label="单位造价(EPC)" unit="元/Wh" step={0.01} value={params.epcPrice} onChange={(v:any)=>setParams({...params, epcPrice:v})} tooltip="建议输入 0.98 ~ 1.60" />
                <InputField label="其他成本系数" unit="%" step={0.01} value={params.otherCostRatio} onChange={(v:any)=>setParams({...params, otherCostRatio:v})} tooltip="管理费、土地等" />
              </div>
            </div>

            {/* 2. 收益参数 - 核心驱动 */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <TrendingUp size={16} className="text-green-600" />
                <h3 className="font-semibold text-gray-800">2. 收益核心驱动</h3>
              </div>
              <div className="p-4">
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">A. 现货套利 (占比~70%)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <InputField label="日循环次数" unit="次" value={params.cyclesPerDay} onChange={(v:any)=>setParams({...params, cyclesPerDay:v})} />
                  <InputField label="年运行天数" unit="天" value={params.runDays} onChange={(v:any)=>setParams({...params, runDays:v})} />
                </div>
                <InputField label="现货净价差" unit="元/kWh" step={0.0001} value={params.spotSpread} onChange={(v:any)=>setParams({...params, spotSpread:v})} tooltip="PDF基准: 0.4509" />
                <div className="grid grid-cols-2 gap-4 bg-yellow-50 p-3 rounded-md border border-yellow-100 mb-2">
                  <InputField label="市场不确定系数" unit="%" step={0.01} value={params.spotMarketUncertainty} onChange={(v:any)=>setParams({...params, spotMarketUncertainty:v})} tooltip="预测偏差修正 (默认0.9)" />
                  <InputField label="交易损耗系数" unit="%" step={0.01} value={params.tradingLossFactor} onChange={(v:any)=>setParams({...params, tradingLossFactor:v})} tooltip="调度/考核损耗 (默认0.95)" />
                </div>
                <div className="mt-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-md text-xs text-blue-900">
                  <p className="font-medium mb-1">按当前参数测算的理论年放电量：</p>
                  <p>
                    约 <span className="font-semibold">{formatNumber(annualDischargeMWh)}</span> MWh
                    （≈ <span className="font-semibold">{formatNumber(annualDischargeMWh / 10)}</span> 万kWh）
                  </p>
                </div>

                <div className="my-4 border-t border-gray-100"></div>
                
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">B. 容量补偿 (政策敏感情景)</h4>
                
                {/* 新增系统时长联动控制 */}
                <div className="bg-blue-50 p-3 rounded-md border border-blue-100 mb-3">
                   <InputField 
                      label="系统时长" 
                      unit="小时" 
                      value={params.systemDuration} 
                      onChange={(v: number) => {
                        // 联动更新 MWh
                        setParams({
                          ...params, 
                          systemDuration: v, 
                          capacityMWh: params.capacityMW * v 
                        });
                      }} 
                      tooltip="调整时长将同步改变MWh和总投资额" 
                   />
                   <div className="text-xs text-blue-600 flex gap-1 mt-1">
                      <Info size={12} className="mt-0.5"/>
                      <span>当前 MWh: <strong>{params.capacityMWh.toFixed(0)}</strong> (已自动同步)</span>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <InputField label="核定放电时长(h)" unit="h" value={params.kFactor} onChange={(v:any)=>setParams({...params, kFactor:v})} tooltip={`对应图片公式中的 h_放电`} />
                  <InputField label="政策调整系数" unit="-" value={params.compPolicyCoeff} onChange={(v:any)=>setParams({...params, compPolicyCoeff:v})} tooltip="考虑实际考核打折，默认1.0或0.65" />
                </div>
                <div className="relative">
                   <InputField label="火电基准补偿单价" unit="元/MW/年" value={params.compStandard} onChange={(v:any)=>setParams({...params, compStandard:v})} tooltip="图片示例: 52万元/MW·年" />
                   <div className="absolute right-0 top-0 mt-8 mr-8 text-xs text-gray-400 pointer-events-none">
                     ≈ {(params.capacityMW * params.kFactor / 24).toFixed(2)} MW (可用容量)
                   </div>
                </div>

                <div className="my-4 border-t border-gray-100"></div>

                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">C. 租赁与辅助</h4>
                <div className="grid grid-cols-2 gap-4">
                  <InputField 
                    label="租赁价格" 
                    unit="元/kW" 
                    value={params.leasePrice} 
                    onChange={(v:any)=>setParams({...params, leasePrice:v})} 
                    tooltip="容量租赁单价，示例：250 元/kW·年" 
                  />
                  <InputField 
                    label="出租率" 
                    unit="%" 
                    step={1} 
                    value={params.leaseRatio} 
                    onChange={(v:any)=>setParams({...params, leaseRatio:v})} 
                    tooltip="以百分比口径输入，例如 50 表示 50% 出租" 
                  />
                </div>
                <InputField label="辅助服务年收入" unit="万元" value={params.auxIncome} onChange={(v:any)=>setParams({...params, auxIncome:v})} tooltip="调频等其他收入" />
              </div>
            </div>

            {/* 3. 融资与税务 */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <DollarSign size={16} className="text-purple-600" />
                <h3 className="font-semibold text-gray-800">3. 融资与税务</h3>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 gap-4">
                  <InputField label="贷款比例" unit="%" step={0.1} value={params.debtRatio} onChange={(v:any)=>setParams({...params, debtRatio:v})} />
                  <InputField label="贷款利率" unit="%" step={0.001} value={params.interestRate} onChange={(v:any)=>setParams({...params, interestRate:v})} />
                </div>
                <InputField label="所得税率" unit="%" step={0.01} value={params.incomeTaxRate} onChange={(v:any)=>setParams({...params, incomeTaxRate:v})} />
              </div>
            </div>

          </div>

          {/* 右侧：结果展示区 */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* 1. 核心KPI卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full -mr-4 -mt-4"></div>
                <p className="text-sm text-gray-500 font-medium relative z-10">全投资 IRR</p>
                <p className={`text-2xl font-bold mt-1 relative z-10 ${results.projectIRR > 0.08 ? 'text-blue-600' : 'text-red-500'}`}>
                  {formatPercent(results.projectIRR)}
                </p>
                <p className="text-xs text-gray-400 mt-2">资本金IRR: <span className="text-gray-700 font-semibold">{formatPercent(results.equityIRR)}</span></p>
              </div>

              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-green-50 rounded-bl-full -mr-4 -mt-4"></div>
                <p className="text-sm text-gray-500 font-medium relative z-10">总投资额</p>
                <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                  {(results.totalInvestment / 10000 / 10000).toFixed(2)} <span className="text-sm font-normal text-gray-500">亿元</span>
                </p>
                <p className="text-xs text-gray-400 mt-2">单位投资: {params.epcPrice} 元/Wh</p>
              </div>

              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative overflow-hidden">
                 <div className="absolute top-0 right-0 w-16 h-16 bg-purple-50 rounded-bl-full -mr-4 -mt-4"></div>
                <p className="text-sm text-gray-500 font-medium relative z-10">静态回收期</p>
                <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                  {results.paybackPeriod.toFixed(1)} <span className="text-sm font-normal text-gray-500">年</span>
                </p>
                <p className="text-xs text-gray-400 mt-2">项目NPV: {(results.npv / 10000).toFixed(0)} 万元</p>
              </div>

               <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative overflow-hidden">
                 <div className="absolute top-0 right-0 w-16 h-16 bg-orange-50 rounded-bl-full -mr-4 -mt-4"></div>
                <p className="text-sm text-gray-500 font-medium relative z-10">首年总收入</p>
                <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                  {formatNumber(results.yearlyData[0].revenue)} <span className="text-sm font-normal text-gray-500">万元</span>
                </p>
                <p className="text-xs text-gray-400 mt-2">净利润: {formatNumber(results.yearlyData[0].netProfit)} 万元</p>
              </div>
            </div>

            {/* 2. 图表：现金流瀑布 */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-gray-800">全生命周期现金流分析</h3>
                <div className="flex items-center gap-2 text-sm">
                   <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-blue-500"></span> 净现金流</span>
                   <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-500"></span> 累计现金流</span>
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

            {/* 3. 收入结构分析 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-gray-800">首年收入构成</h3>
                  <span className="text-lg font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100">
                    合计: {formatNumber(results.yearlyData[0].revenue)} 万元
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
                     const percent = (item.value / total) * 100;
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
                     )
                  })}
                </div>
                <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-100 text-sm text-blue-800">
                   <p className="flex items-start gap-2">
                     <Info size={16} className="mt-0.5 shrink-0" />
                     <span>
                       财务提示：现货套利收入占比 <strong>{((results.yearlyData[0].breakdown.spot / results.yearlyData[0].revenue)*100).toFixed(1)}%</strong>。
                       项目高度依赖现货价差(当前输入: {params.spotSpread}元/kWh)，建议在左侧进行敏感性测试。
                     </span>
                   </p>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                 <h3 className="text-lg font-bold text-gray-800 mb-4">财务指标校验</h3>
                 <div className="space-y-4 text-sm">
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                       <span className="text-gray-500">初始总投资 (CAPEX)</span>
                       <span className="font-mono">{(results.totalInvestment / 10000).toFixed(0)} 万元</span>
                    </div>
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                       <span className="text-gray-500">其中：自有资金 (Equity)</span>
                       <span className="font-mono text-blue-600">{(results.equityAmount / 10000).toFixed(0)} 万元</span>
                    </div>
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                       <span className="text-gray-500">其中：银行贷款 (Debt)</span>
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
                       <span className="text-gray-500 font-medium">净现值 (NPV @8%)</span>
                       <span className="font-bold text-gray-800">{(results.npv / 10000).toFixed(0)} 万元</span>
                    </div>
                 </div>
              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
