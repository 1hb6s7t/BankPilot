import type { DomainRole, Planner, ManagementSpec, RedemptionSpec, GoalDraft, ManagementContext, BillReport } from '../packages/contracts/src';
import type { HoldoutFixture } from './holdout-fixtures';

export const g6HoldoutVersion = 'g6-holdout-v1-2026-10-23';
type Expected = { roles: DomainRole[]; suggestions: { payeeId: string; amountMinor: string }[]; managementSuggestions: ManagementSpec[]; investmentSuggestions: RedemptionSpec[]; goalSuggestion?: GoalDraft; clarification: boolean; requiredSummaryFragments?: string[]; forbiddenSummaryFragments?: string[] };
const acc = (id: string) => ({ id: `g6-${id}-account`, name: '合成日常账户', maskedNumber: '****9026', balanceMinor: '2100000', reservedMinor: '100000', currency: 'CNY' as const });
const payees = (id: string, twin = false) => twin ? [{ id:`g6-${id}-payee-a`, name:'顾闻溪', bank:'合成北辰银行', maskedNumber:'****3182', aliases:[] }, { id:`g6-${id}-payee-b`, name:'顾闻溪', bank:'合成南汀银行', maskedNumber:'****8407', aliases:[] }] : [{ id:`g6-${id}-payee`, name:'沈知遥', bank:'合成云岫银行', maskedNumber:'****5591', aliases:['遥遥'] }];
const cards = (id:string) => [
 { id:`g6-${id}-card-main`, accountId:`g6-${id}-account`, name:'栖月主卡', maskedNumber:'****6428', status:'ACTIVE' as const, version:5, updatedAt:'2026-10-20T09:00:00.000Z' },
 { id:`g6-${id}-card-travel`, accountId:`g6-${id}-account`, name:'远汀旅行卡', maskedNumber:'****1763', status:'LOST' as const, version:3, updatedAt:'2026-10-20T09:05:00.000Z' },
];
const subContext = (id:string) => ({ queriedAt:'2026-10-22T03:00:00.000Z', accessExpiresAt:'2100-01-01T00:00:00.000Z', queryActionId:`g6-${id}-query`, items:[
 { id:`g6-${id}-sub-music`, merchant:'弦月音乐', amountMinor:'2580', currency:'CNY' as const, nextChargeDate:'2026-11-12', cardId:`g6-${id}-card-main`, merchantStatus:'ACTIVE' as const, bankStatus:'ALLOWED' as const, collectionStatus:'ENABLED' as const, version:6, cancellationSupported:true, source:'SYNTHETIC_MERCHANT' as const },
 { id:`g6-${id}-sub-news`, merchant:'晨汐读刊', amountMinor:'990', currency:'CNY' as const, nextChargeDate:'2026-11-15', cardId:`g6-${id}-card-travel`, merchantStatus:'ACTIVE' as const, bankStatus:'ALLOWED' as const, collectionStatus:'BLOCKED_BY_CARD' as const, version:2, cancellationSupported:false, source:'SYNTHETIC_MERCHANT' as const },
] });
const inv = (id:string) => ({ businessDate:'2026-10-23', calendar:'DEMO_WEEKDAYS_V1' as const, actions:[], products:[{id:`g6-${id}-prod-liquid`,name:'月汐灵活存 T+0',redemptionBusinessDays:0,calendar:'DEMO_WEEKDAYS_V1' as const,description:'合成产品，即时到账'},{id:`g6-${id}-prod-balance`,name:'青岚均衡计划 T+2',redemptionBusinessDays:2,calendar:'DEMO_WEEKDAYS_V1' as const,description:'合成产品，两个工作日到账'}], positions:[{id:`g6-${id}-pos-liquid`,accountId:`g6-${id}-account`,productId:`g6-${id}-prod-liquid`,productName:'月汐灵活存 T+0',principalMinor:'900000',reservedMinor:'100000',availableMinor:'800000',version:8,redemptionBusinessDays:0,calendar:'DEMO_WEEKDAYS_V1' as const},{id:`g6-${id}-pos-balance`,accountId:`g6-${id}-account`,productId:`g6-${id}-prod-balance`,productName:'青岚均衡计划 T+2',principalMinor:'1500000',reservedMinor:'200000',availableMinor:'1300000',version:11,redemptionBusinessDays:2,calendar:'DEMO_WEEKDAYS_V1' as const}] });
const fund = (id:string, amount:string) => ({accountId:`g6-${id}-account`,amountMinor:amount,balanceMinor:'2100000',reservedMinor:'100000',availableBeforeMinor:'2000000',availableAfterMinor:(2000000n-BigInt(amount)).toString(),protectedMinor:'500000',spendableMinor:'1500000',shortfallMinor:'0',allowed:true,policyVersion:4,horizonEnd:'2026-12-01',obligations:[{id:`g6-${id}-rent`,title:'11月住房支出',amountMinor:'350000',dueDate:'2026-11-05'},{id:`g6-${id}-living`,title:'生活备用金',amountMinor:'150000',dueDate:'2026-11-18'}],reasons:['支付后仍覆盖住房、生活备用金和最低余额。']});
function billReport(id:string, period:string):BillReport {
 const sid=`g6-${id}-statement-${period}`, accountId=`g6-${id}-account`;
 const transactions:BillReport['transactions']=[
  {id:`${sid}-salary`,accountId,bookedAt:`${period}-02`,merchant:'合成星桥薪酬',amountMinor:'1680000',direction:'IN',category:'收入',source:'SYNTHETIC_STATEMENT'},
  {id:`${sid}-market`,accountId,bookedAt:`${period}-09`,merchant:'合成溪岸生鲜',amountMinor:'7460',direction:'OUT',category:'餐饮',source:'SYNTHETIC_STATEMENT'},
  {id:`${sid}-transit`,accountId,bookedAt:`${period}-16`,merchant:'合成环城出行',amountMinor:'3280',direction:'OUT',category:'交通',source:'SYNTHETIC_STATEMENT'},
 ];
 return {period,source:'SYNTHETIC',incomeMinor:'1680000',expenseMinor:'10740',netMinor:'1669260',previousExpenseMinor:'0',generatedAt:'2026-10-22T04:00:00.000Z',categories:[{category:'餐饮',amountMinor:'7460',count:1,transactionIds:[`${sid}-market`]},{category:'交通',amountMinor:'3280',count:1,transactionIds:[`${sid}-transit`]}],transactions,evidenceTransactions:[],findings:[]};
}
function make(id:string, category:string, message:string, expected:Expected, opts:{fund?:string; card?:boolean; sub?:boolean; investment?:boolean; twin?:boolean; billPeriod?:string}={}):HoldoutFixture {
 const input:Parameters<Planner['plan']>[0]={taskId:`g6-task-${id}`,message,accounts:[acc(id)],payees:payees(id,opts.twin),...(opts.fund?{fundsPreview:fund(id,opts.fund)}:{}),...(opts.billPeriod?{billReport: billReport(id,opts.billPeriod)}:{}),...((opts.card||opts.sub)?{managementContext:{cards:cards(id),...(opts.sub?{subscriptions:subContext(id)}:{})} satisfies ManagementContext}:{}),...(opts.investment?{investmentContext:inv(id)}:{})};
 return {id,category,input,expected};
}
const none=(roles:DomainRole[],clarification=false,more:Partial<Expected>={}):Expected=>({roles,clarification,suggestions:[],managementSuggestions:[],investmentSuggestions:[],...more});
const trans=(id:string,amount:string):Expected=>({...none(['transfer']),suggestions:[{payeeId:`g6-${id}-payee`,amountMinor:amount}]});
const mgmt=(roles:DomainRole[],item:ManagementSpec,more:Partial<Expected>={}):Expected=>({...none(roles),managementSuggestions:[item],...more});
export const g6HoldoutFixtures:HoldoutFixture[]=[
 make('g601','转账 / 口语金额','麻烦从账户给沈知遥打个三百零七块五，备注书展票',trans('g601','30750'),{fund:'30750'}),
 make('g602','转账 / 金额续接','再给沈知遥转 86.40 元，沿用刚才那个收款人',trans('g602','8640'),{fund:'8640'}),
 make('g603','转账 / 否定改口','沈知遥那笔 520 元先撤回计划，我只是问手续费，不要发起转账',none(['transfer'],false,{forbiddenSummaryFragments:['已转账']}),{fund:'52000'}),
 make('g604','转账 / 同名安全澄清','给顾闻溪汇 1,260 元，收款人我没说是哪家银行',none(['transfer'],true),{twin:true,fund:'126000'}),
 make('g605','账单 / 分类支出查询','帮我看2026年8月餐饮和出行各花了多少，按流水说明',none(['bills'],false,{requiredSummaryFragments:['2026-08','g6-g605-statement-2026-08-market','g6-g605-statement-2026-08-transit']}),{billPeriod:'2026-08'}),
 make('g606','账单 / 指定收支比较','对比我2026年7月和8月的收入支出变化',none(['bills'],true,{requiredSummaryFragments:['无法比较']}),{billPeriod:'2026-08'}),
 make('g607','账单 / 交易证据追问','查2026年6月金额最高的三笔支出，列出对应交易依据',none(['bills'],false,{requiredSummaryFragments:['2026-06','g6-g607-statement-2026-06-market','g6-g607-statement-2026-06-transit']}),{billPeriod:'2026-06'}),
 make('g608','账单 / 无数据月份','看看2027年2月账单里有没有订阅扣款',none(['bills'],true,{requiredSummaryFragments:['2027-02']})),
 make('g609','理财 / 别名只读查询','我那笔月汐灵活存现在还能取多少？只查一下',none(['investment'],false,{requiredSummaryFragments:['月汐灵活存']}),{investment:true}),
 make('g610','理财 / 位置明确赎回','从青岚均衡计划赎回 425.80 元', {...none(['investment']),investmentSuggestions:[{positionId:'g6-g610-pos-balance',amountMinor:'42580',expectedVersion:11}]},{investment:true}),
 make('g611','理财 / 未登记产品简称澄清','把“月汐”里 208 元赎出来',none(['investment'],true),{investment:true}),
 make('g612','理财 / 产品歧义保护','从我的理财里拿 300 元出来，具体哪只我不确定',none(['investment'],true),{investment:true}),
 make('g613','卡片 / 两卡状态查询','栖月主卡和远汀旅行卡现在分别是什么状态？',none(['card'],false,{requiredSummaryFragments:['栖月主卡','远汀旅行卡']}),{card:true}),
 make('g614','卡片 / 未登记简称澄清','把我常用的栖月卡先挂失一下',none(['card'],true),{card:true}),
 make('g615','卡片 / 指代名称澄清','远汀那张旅行卡已经找到了，帮我恢复使用',none(['card'],true),{card:true}),
 make('g616','卡片 / 未指明卡片','请把我的卡停用',none(['card'],true),{card:true}),
 make('g617','订阅 / 查询项目','有哪些自动续费快要扣款？给我看看商户和日期',mgmt(['subscription'],{kind:'SUBSCRIPTION_QUERY'}),{card:true}),
 make('g618','订阅 / 银行拦截与商户取消区分','不要续扣弦月音乐的费用，只在银行这边拦截后续扣款',mgmt(['subscription'],{kind:'SUBSCRIPTION_BLOCK',subscriptionId:'g6-g618-sub-music',expectedVersion:6,queryActionId:'g6-g618-query'},{requiredSummaryFragments:['不会取消商户合同']}),{card:true,sub:true}),
 make('g619','订阅 / 商户侧取消','取消弦月音乐的商户会员，银行扣款权限也不要当成商户取消',mgmt(['subscription'],{kind:'SUBSCRIPTION_CANCEL',subscriptionId:'g6-g619-sub-music',expectedVersion:6,queryActionId:'g6-g619-query'}),{card:true,sub:true}),
 make('g620','订阅 / 未支持商户取消','请终止晨汐读刊的会员续订',none(['subscription'],false,{forbiddenSummaryFragments:['已取消']}),{card:true,sub:true}),
 make('g621','目标 / 日期年份缺失须澄清','帮我为沈知遥准备一笔搬家款，12月10日前攒到 2,350 元',none(['goal'],true,{requiredSummaryFragments:['年份']}),{fund:'235000'}),
 make('g622','目标 / 生活目标缺日期','给沈知遥留一笔 780 元的课程报名钱，做成目标',none(['goal'],true,{requiredSummaryFragments:['日期']}),{fund:'78000'}),
 make('g623','目标 / 明确理财来源筹资','计划在2026-12-18前为沈知遥准备 1,125.50 元搬家费用，先从青岚均衡计划赎回1,300元',none(['goal','investment'],false,{goalSuggestion:{title:'搬家费用储备',accountId:'g6-g623-account',payeeId:'g6-g623-payee',amountMinor:'112550',targetDate:'2026-12-18',funding:{positionId:'g6-g623-pos-balance',redemptionAmountMinor:'130000'}},requiredSummaryFragments:['到账']}),{fund:'112550',investment:true}),
 make('g624','目标 / 收款人同名保护','在2026-12-20前给顾闻溪准备 640 元探亲路费',none(['goal'],true),{twin:true,fund:'64000'}),
];

// Frozen representative live subset, selected before any execution.
export const g6HoldoutLiveCaseIds = ['g601','g604','g605','g609','g612','g614','g615','g618','g619','g621','g622','g624'] as const;
