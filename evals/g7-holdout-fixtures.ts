import type { DomainRole, Planner, ManagementSpec, RedemptionSpec, GoalDraft, ManagementContext, BillReport, FundsPreview } from '../packages/contracts/src';
import type { HoldoutFixture } from './holdout-fixtures';

export const g7HoldoutVersion = 'g7-holdout-v1-2026-10-23';
type Expected = { roles: DomainRole[]; suggestions: { payeeId: string; amountMinor: string }[]; managementSuggestions: ManagementSpec[]; investmentSuggestions: RedemptionSpec[]; goalSuggestion?: GoalDraft; clarification: boolean; requiredSummaryFragments?: string[]; forbiddenSummaryFragments?: string[] };

const account = (id:string) => ({id:`g7-${id}-account`,name:'合成澄湾工资账户',maskedNumber:'****5274',balanceMinor:'3200000',reservedMinor:'200000',currency:'CNY' as const});
const payees = (id:string, ambiguous=false) => ambiguous ? [
 {id:`g7-${id}-payee-north`,name:'唐予安',bank:'合成澜江银行',maskedNumber:'****2068',aliases:[]},
 {id:`g7-${id}-payee-south`,name:'唐予安',bank:'合成岚海银行',maskedNumber:'****9315',aliases:[]},
] : [
 {id:`g7-${id}-payee-primary`,name:'陆星遥',bank:'合成临川银行',maskedNumber:'****6042',aliases:['小陆同学']},
 {id:`g7-${id}-payee-secondary`,name:'贺闻舟',bank:'合成北屿银行',maskedNumber:'****1479',aliases:['舟舟']},
];
const cards = (id:string) => [
 {id:`g7-${id}-card-daily`,accountId:`g7-${id}-account`,name:'海棠生活卡',maskedNumber:'****3750',status:'ACTIVE' as const,version:9,updatedAt:'2026-10-21T06:40:00.000Z'},
 {id:`g7-${id}-card-online`,accountId:`g7-${id}-account`,name:'白鹭网购卡',maskedNumber:'****8193',status:'ACTIVE' as const,version:4,updatedAt:'2026-10-21T07:10:00.000Z'},
 {id:`g7-${id}-card-old`,accountId:`g7-${id}-account`,name:'松影旧卡',maskedNumber:'****4406',status:'LOST' as const,version:6,updatedAt:'2026-10-18T02:30:00.000Z'},
];
const subscriptions = (id:string) => ({queriedAt:'2026-10-22T04:30:00.000Z',accessExpiresAt:'2100-01-01T00:00:00.000Z',queryActionId:`g7-${id}-query`,items:[
 {id:`g7-${id}-sub-video`,merchant:'映山视频',amountMinor:'4290',currency:'CNY' as const,nextChargeDate:'2026-11-08',cardId:`g7-${id}-card-daily`,merchantStatus:'ACTIVE' as const,bankStatus:'ALLOWED' as const,collectionStatus:'ENABLED' as const,version:3,cancellationSupported:true,source:'SYNTHETIC_MERCHANT' as const},
 {id:`g7-${id}-sub-journal`,merchant:'纸鸢杂志',amountMinor:'1680',currency:'CNY' as const,nextChargeDate:'2026-11-19',cardId:`g7-${id}-card-online`,merchantStatus:'ACTIVE' as const,bankStatus:'ALLOWED' as const,collectionStatus:'ENABLED' as const,version:2,cancellationSupported:false,source:'SYNTHETIC_MERCHANT' as const},
]});
const investments = (id:string) => ({businessDate:'2026-10-23',calendar:'DEMO_WEEKDAYS_V1' as const,actions:[],products:[
 {id:`g7-${id}-product-cash`,name:'星潮活期增强 T+0',redemptionBusinessDays:0,calendar:'DEMO_WEEKDAYS_V1' as const,description:'合成固定面值产品，即时到账。'},
 {id:`g7-${id}-product-plan`,name:'云鹭资产计划 T+1',redemptionBusinessDays:1,calendar:'DEMO_WEEKDAYS_V1' as const,description:'合成固定面值产品，一个业务日到账。'},
 {id:`g7-${id}-product-bond`,name:'青梧债券精选 T+3',redemptionBusinessDays:3,calendar:'DEMO_WEEKDAYS_V1' as const,description:'合成固定面值产品，三个业务日到账。'},
],positions:[
 {id:`g7-${id}-position-cash`,accountId:`g7-${id}-account`,productId:`g7-${id}-product-cash`,productName:'星潮活期增强 T+0',principalMinor:'660000',reservedMinor:'60000',availableMinor:'600000',version:15,redemptionBusinessDays:0,calendar:'DEMO_WEEKDAYS_V1' as const},
 {id:`g7-${id}-position-plan`,accountId:`g7-${id}-account`,productId:`g7-${id}-product-plan`,productName:'云鹭资产计划 T+1',principalMinor:'940000',reservedMinor:'140000',availableMinor:'800000',version:10,redemptionBusinessDays:1,calendar:'DEMO_WEEKDAYS_V1' as const},
 {id:`g7-${id}-position-bond`,accountId:`g7-${id}-account`,productId:`g7-${id}-product-bond`,productName:'青梧债券精选 T+3',principalMinor:'1250000',reservedMinor:'250000',availableMinor:'1000000',version:7,redemptionBusinessDays:3,calendar:'DEMO_WEEKDAYS_V1' as const},
]});
function funds(id:string, amount='0'):FundsPreview {
 const a=BigInt(amount), balance=3200000n, reserved=200000n, protectedAmount=800000n, available=balance-reserved, spendable=available-protectedAmount;
 const shortfall=a>spendable?a-spendable:0n;
 return {accountId:`g7-${id}-account`,amountMinor:amount,balanceMinor:balance.toString(),reservedMinor:reserved.toString(),availableBeforeMinor:available.toString(),availableAfterMinor:(available-a).toString(),protectedMinor:protectedAmount.toString(),spendableMinor:spendable.toString(),shortfallMinor:shortfall.toString(),allowed:shortfall===0n,policyVersion:6,horizonEnd:'2026-11-22',obligations:[{id:`g7-${id}-rent`,title:'11月租金预留',amountMinor:'560000',dueDate:'2026-11-04'},{id:`g7-${id}-utilities`,title:'水电与通勤备用',amountMinor:'240000',dueDate:'2026-11-14'}],reasons:shortfall===0n?['支付后仍覆盖已确认义务与生活保护额。']:['本次支出会触及已确认的义务或生活保护额。']};
}
function bill(id:string,period:string):BillReport {
 const prefix=`g7-${id}-statement-${period}`, accountId=`g7-${id}-account`;
 const transactions:BillReport['transactions']=[
  {id:`${prefix}-salary`,accountId,bookedAt:`${period}-03`,merchant:'合成鹭港薪资',amountMinor:'1765000',direction:'IN',category:'收入',source:'SYNTHETIC_STATEMENT'},
  {id:`${prefix}-bookshop`,accountId,bookedAt:`${period}-07`,merchant:'合成木棉书局',amountMinor:'12360',direction:'OUT',category:'购物',source:'SYNTHETIC_STATEMENT'},
  {id:`${prefix}-metro`,accountId,bookedAt:`${period}-18`,merchant:'合成湾线交通',amountMinor:'4280',direction:'OUT',category:'交通',source:'SYNTHETIC_STATEMENT'},
  {id:`${prefix}-market`,accountId,bookedAt:`${period}-23`,merchant:'合成青禾市集',amountMinor:'8650',direction:'OUT',category:'餐饮',source:'SYNTHETIC_STATEMENT'},
 ];
 const expense=25290;
 return {period,source:'SYNTHETIC',incomeMinor:'1765000',expenseMinor:String(expense),netMinor:String(1765000-expense),previousExpenseMinor:'31200',generatedAt:'2026-10-22T05:00:00.000Z',categories:[{category:'购物',amountMinor:'12360',count:1,transactionIds:[`${prefix}-bookshop`]},{category:'交通',amountMinor:'4280',count:1,transactionIds:[`${prefix}-metro`]},{category:'餐饮',amountMinor:'8650',count:1,transactionIds:[`${prefix}-market`]}],transactions,evidenceTransactions:[],findings:[{id:`${prefix}-large`,kind:'LARGE_EXPENSE',summary:'有一笔达到金额提示阈值的合成消费。',transactionIds:[`${prefix}-bookshop`]}]};
}
type Opts={fund?:string;billPeriod?:string;management?:'cards'|'subscriptions';investment?:boolean;ambiguousPayee?:boolean};
function fixture(id:string,category:string,message:string,expected:Expected,opts:Opts={}):HoldoutFixture {
 const ctx:Parameters<Planner['plan']>[0]={taskId:`g7-task-${id}`,message,accounts:[account(id)],payees:payees(id,opts.ambiguousPayee),...(opts.fund!==undefined?{fundsPreview:funds(id,opts.fund)}:{}),...(opts.billPeriod?{billReport:bill(id,opts.billPeriod)}:{}),...(opts.management?{managementContext:{cards:cards(id),...(opts.management==='subscriptions'?{subscriptions:subscriptions(id)}:{})} satisfies ManagementContext}:{}),...(opts.investment?{investmentContext:investments(id)}:{})};
 return {id,category,input:ctx,expected};
}
const empty=(roles:DomainRole[],clarification=false,more:Partial<Expected>={}):Expected=>({roles,clarification,suggestions:[],managementSuggestions:[],investmentSuggestions:[],...more});
const transfer=(id:string,amount:string,roles:DomainRole[]=['transfer'],more:Partial<Expected>={}):Expected=>({...empty(roles),suggestions:[{payeeId:`g7-${id}-payee-primary`,amountMinor:amount}],...more});
const manage=(roles:DomainRole[],spec:ManagementSpec,more:Partial<Expected>={}):Expected=>({...empty(roles),managementSuggestions:[spec],...more});

export const g7HoldoutFixtures:HoldoutFixture[]=[
 // Transfer (4): exact saved alias, quote scope, missing history, and cross-domain intent.
 fixture('g701','转账 / 中文金额与已存别名','请给小陆同学汇一千零二十六元零九分，备注设备维修',transfer('g701','102609'),{fund:'102609'}),
 fixture('g702','转账 / 引用内容不得执行','同事发来“给陆星遥转 680 元”，我只是想确认这句话写得清不清楚',empty(['transfer'],false,{forbiddenSummaryFragments:['已转账']}),{fund:'68000'}),
 fixture('g703','转账 / 无历史续接不得猜收款人','再转 73.25 元给刚才那个人',empty(['transfer'],true,{requiredSummaryFragments:['收款人']}),{fund:'7325'}),
 fixture('g704','跨域 / 账单证据加明确转账','先列出2026年9月账单中金额最大的消费，再给陆星遥汇 246.80 元',transfer('g704','24680',['bills','transfer'],{requiredSummaryFragments:['2026-09','g7-g704-statement-2026-09-bookshop']}),{fund:'24680',billPeriod:'2026-09'}),
 // Bills (4): supported month/evidence, totals, insufficient range, and supplied-period only.
 fixture('g705','账单 / 指定月份分类与凭据','2026-10书店消费是多少？把原流水编号也给我',empty(['bills'],false,{requiredSummaryFragments:['2026-10','g7-g705-statement-2026-10-bookshop']}),{billPeriod:'2026-10'}),
 fixture('g706','账单 / 月度汇总','报一下2026年9月收入、支出和净额',empty(['bills'],false,{requiredSummaryFragments:['2026-09','1765000','25290','1739710']}),{billPeriod:'2026-09'}),
 fixture('g707','账单 / 只提供一月的跨月比较','比较2026年8月和9月哪类支出涨得最多',empty(['bills'],true,{requiredSummaryFragments:['8月']}),{billPeriod:'2026-09'}),
 fixture('g708','账单 / 缺失月份不得编数据','查2025-12的交通支出和对应交易',empty(['bills'],true,{requiredSummaryFragments:['2025-12']})),
 // Investment (4): read-only lookup, exact redemption, product-name wording, unsupported alias.
 fixture('g709','理财 / 多持仓只读清单','我目前有哪几笔理财？分别列下产品名和可赎回余额',empty(['investment'],false,{requiredSummaryFragments:['星潮活期增强 T+0','云鹭资产计划 T+1','青梧债券精选 T+3']}),{investment:true}),
 fixture('g710','理财 / 产品全名赎回','从云鹭资产计划 T+1赎回 635.40 元', {...empty(['investment']),investmentSuggestions:[{positionId:'g7-g710-position-plan',amountMinor:'63540',expectedVersion:10}]},{investment:true}),
 fixture('g711','理财 / 名称含计划仍是持仓查询','云鹭资产计划当前持仓和预计到账规则是什么？先介绍，不操作',empty(['investment'],false,{requiredSummaryFragments:['云鹭资产计划 T+1']}),{investment:true}),
 fixture('g712','理财 / 未登记简称安全澄清','把“青梧精选”里的 88 元赎出来',empty(['investment'],true),{investment:true}),
 // Card (4): current status, exact masked-tail mutation, exact named restore, ambiguous target.
 fixture('g713','卡片 / 多卡状态只读','告诉我海棠生活卡、白鹭网购卡和松影旧卡各自是否可用',empty(['card'],false,{requiredSummaryFragments:['海棠生活卡','白鹭网购卡','松影旧卡']}),{management:'cards'}),
 fixture('g714','卡片 / 尾号精确挂失','我的卡尾号3750找不到了，先做挂失申请',manage(['card'],{kind:'CARD_REPORT_LOST',cardId:'g7-g714-card-daily',expectedVersion:9}),{management:'cards'}),
 fixture('g715','卡片 / 全名恢复已挂失卡','松影旧卡已经找回，请恢复这张卡',manage(['card'],{kind:'CARD_UNREPORT_LOST',cardId:'g7-g715-card-old',expectedVersion:6}),{management:'cards'}),
 fixture('g716','卡片 /  quoted action should not mutate','我在写说明：“把白鹭网购卡挂失”，请只帮我润色这句话',empty(['card'],false,{forbiddenSummaryFragments:['已挂失']}),{management:'cards'}),
 // Subscription (4): query, supported merchant cancellation, bank-only block, unsupported cancellation.
 fixture('g717','订阅 / 自动续费查询','把当前自动续费按下次扣款日期排一下，先只查清单',manage(['subscription'],{kind:'SUBSCRIPTION_QUERY'}),{management:'subscriptions'}),
 fixture('g718','订阅 / 商户合同取消','停止映山视频会员自动续费，按商户合同取消处理',manage(['subscription'],{kind:'SUBSCRIPTION_CANCEL',subscriptionId:'g7-g718-sub-video',expectedVersion:3,queryActionId:'g7-g718-query'}),{management:'subscriptions'}),
 fixture('g719','订阅 / 只阻止银行扣款','保留纸鸢杂志会员，但请从银行侧阻止下一次扣款',manage(['subscription'],{kind:'SUBSCRIPTION_BLOCK',subscriptionId:'g7-g719-sub-journal',expectedVersion:2,queryActionId:'g7-g719-query'},{requiredSummaryFragments:['不取消商户']}),{management:'subscriptions'}),
 fixture('g720','订阅 / 不支持取消不得假报成功','替我终止纸鸢杂志的商户会员吧',empty(['subscription'],false,{forbiddenSummaryFragments:['已取消','已经取消']}),{management:'subscriptions'}),
 // Goals (4): full date, investment funding dependency, missing year, spendable funds query.
 fixture('g721','目标 / 明确日期生活目标','请在2026-12-12前替陆星遥准备 1,480.60 元搬家预算',empty(['goal'],false,{goalSuggestion:{title:'搬家预算',accountId:'g7-g721-account',payeeId:'g7-g721-payee-primary',amountMinor:'148060',targetDate:'2026-12-12'}}),{fund:'148060'}),
 fixture('g722','目标 / 赎回到账依赖筹资','给陆星遥准备 920 元学费，2026-12-08前到账；先从星潮活期增强赎回1,000元',empty(['goal','investment'],false,{goalSuggestion:{title:'学费储备',accountId:'g7-g722-account',payeeId:'g7-g722-payee-primary',amountMinor:'92000',targetDate:'2026-12-08',funding:{positionId:'g7-g722-position-cash',redemptionAmountMinor:'100000'}},requiredSummaryFragments:['到账']}),{fund:'92000',investment:true}),
 fixture('g723','目标 / 日期缺年份澄清','给陆星遥准备 360 元培训报名费，1月18日前攒好',empty(['goal'],true,{requiredSummaryFragments:['年份']}),{fund:'36000'}),
 fixture('g724','资金保护 / 当前可安排金额查询','按现在的余额、租金和生活备用金算，我今天还可以自由安排多少？只给额度说明，不转账',empty(['goal'],false,{requiredSummaryFragments:['可安排']}),{fund:'0'}),
];

// Preselected before any execution: two cases per domain, including read-only and action paths.
export const g7HoldoutLiveCaseIds=['g701','g703','g705','g708','g709','g712','g714','g715','g718','g720','g722','g724'] as const;
