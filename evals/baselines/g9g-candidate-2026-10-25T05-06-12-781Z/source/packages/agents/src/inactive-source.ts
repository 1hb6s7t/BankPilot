/** Pure source-only vetoes for quoted/history/withdrawn data. This module never
 * chooses an entity, fills a slot, repairs source, or grants a current action. */
export type InactiveSourceSpan = { start: number; end: number; text: string };
export type QuotedRange = { start: number; end: number };
export function quotedRanges(text: string): QuotedRange[] {
  return [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)/g)].map(m=>({start:m.index!,end:m.index!+m[0].length}));
}
function completeQuote(text: string,range: QuotedRange): boolean {
  const value=text.slice(range.start,range.end);
  return /^(?:```[\s\S]*```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*")$/.test(value);
}
export function sourceClauses(text: string): string[] {
  const parts: string[]=[];let start=0;
  for(const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)|[，,。；;\n！？?!]/g)) {
    if(!/^[，,。；;\n！？?!]$/.test(match[0]))continue;
    parts.push(text.slice(start,match.index));start=match.index!+match[0].length;
  }
  parts.push(text.slice(start));return parts.map(part=>part.trim()).filter(Boolean);
}
function outsideQuotes(text: string): string {
  let visible=text;
  for(const range of quotedRanges(text).reverse())visible=visible.slice(0,range.start)+'引用文字'+visible.slice(range.end);
  return visible;
}
const requestPrefix=/^(?:请你|请|帮我|替我|麻烦|先|再|另外|然后|顺便|同时|并且|并|但是|但|不过|现在|今天|本次|这次|暂时|也|直接|马上|立即|立刻|务必|就|我现在|我还要|我还想|我还需要|我想|我要|还要|还请|还想|还需要|继续)/;
function requestHead(text: string): string {
  let value=text.trim();
  for(let count=0;count<8;count++) {const prefix=value.match(requestPrefix)?.[0];if(!prefix)break;value=value.slice(prefix.length).trimStart();}
  return value;
}
function currentCommandAtHead(text: string): boolean {
  const value=requestHead(text);
  return /^(?:查询|查看|看看|查一下|核对|分析|统计|比较|展示|列出|挂失|报失|解挂|恢复|取消|退订|终止订阅|阻止|拦截|赎回|赎出|取回|转账|转给|汇款|汇给|打给|付款|支付|建立|创建|建个|准备|攒好|攒够)/.test(value)
    || /^查(?:本月|上月|上个月|这个月|当月|账单|银行卡|卡片|理财|持仓|订阅|资金|余额|\d{4}[-/年])/.test(value)
    || /^(?:给|向)[^，,。；;]{1,60}(?:转|汇|元|块)/.test(value)
    || /^从[^，,。；;]{1,80}(?:赎回|赎出)/.test(value);
}
function negatedLeadEnd(text: string): number {
  let cursor=0;
  const consumeSpace=()=>{const space=text.slice(cursor).match(/^\s*/)?.[0]??'';cursor+=space.length;};
  consumeSpace();
  for(let count=0;count<8;count++) {
    const prefix=text.slice(cursor).match(requestPrefix)?.[0];
    if(!prefix)break;cursor+=prefix.length;consumeSpace();
  }
  const negative=text.slice(cursor).match(/^(?:不需要|不打算|不准备|不想|不要|不用|不必|无需|暂不|先不|不再|别)/)?.[0];
  if(!negative)return 0;
  cursor+=negative.length;consumeSpace();
  // These adverbs modify the negated verb, not a new affirmative command. The
  // scan ends before that verb, so a subsequent 再给/并查询 still gets checked.
  for(let count=0;count<8;count++) {
    const qualifier=text.slice(cursor).match(/^(?:暂时|现在|同时|继续|直接|马上|立即|立刻|再|先|也|就)/)?.[0];
    if(!qualifier)break;cursor+=qualifier.length;consumeSpace();
  }
  return cursor;
}

/** A later affirmative operation remains current despite an earlier historical
 * prefix or a different negated operation. Quotes are masked before scanning. */
export function currentInstructionOutsideQuotes(text: string): boolean {
  const visible=outsideQuotes(text);
  return sourceClauses(visible).some(clause=>{
    if(currentCommandAtHead(clause))return true;
    const negativePrefixEnd=negatedLeadEnd(clause);
    for(const match of clause.matchAll(/但是|不过|然后|另外|同时|并且|以及|并|再|现在|今天|我还要|我还想|我还需要|我想|我要|还要|还请|还想|还需要|继续|也|直接|马上|立即|立刻|务必/g)) {
      if(match.index!<negativePrefixEnd)continue;
      if(match.index!>0&&currentCommandAtHead(clause.slice(match.index!)))return true;
    }
    // Two adjacent payment instructions cannot be made inactive by putting one
    // negative/historical marker before both. Keep this veto currency-bounded.
    for(const match of clause.matchAll(/(?:元|块|角|毛|分|整|正)\s*(?=(?:请|帮我|替我|麻烦|先|再)*(?:给|向|转给|汇给|打给|转账))/g)) {
      if(currentCommandAtHead(clause.slice(match.index!+match[0].length)))return true;
    }
    return false;
  });
}
const dataTaskPrefix=/^\s*(?:请|帮我|替我|麻烦|只要|仅|先)*(?:改写|润色|翻译|转述|复述|校对|编辑|摘录|引用|记录)/;
const historicalPrefix=/^\s*(?:(?:以下是|这是)?历史记录[：:]|以前|曾经|已经)/;
const historyQuotePrefix=/^(?:(?:我(?:的)?|上次)(?:在)?)?(?:旧稿|草稿|演示稿|笔记|文档|会议记录|培训记录|历史记录|旧账单)(?:里|中|中的|的)?(?:写了|写过|写着|记了|记过|记载了|记录了|记录过|有一句|有一条|原话是|例句是|看到了)?$/;
function completeExample(text: string): boolean {
  const matched=text.match(/^([^，,。；;\n]+?)[，,]?\s*(?:只是|仅是|仅仅是|作为)(?:一个|个|一条|条)?(?:示例|例子|范例)[。.!！\s]*$/);
  return !!matched&&!/示例|例子|范例|但|不过|然后|另外|同时|并且|真正|实际|(?:再|并)(?:给|向|从|转|汇|付|查)/.test(matched[1]!);
}
export function explicitlyDataOnly(message: string,scope: InactiveSourceSpan): boolean {
  if(scope.start!==0||scope.end!==message.length||scope.text!==message)return false;
  if(quotedRanges(scope.text).some(range=>!completeQuote(scope.text,range)))return false;
  if(completeExample(scope.text))return true;
  if(currentInstructionOutsideQuotes(scope.text))return false;
  if(inactiveSourceSupported(scope.text,'historical'))return true;
  if(!dataTaskPrefix.test(scope.text))return false;
  const clauses=sourceClauses(scope.text);
  if(!clauses.slice(1).every(clause=>inactiveSourceSupported(clause,'historical')))return false;
  const ranges=quotedRanges(clauses[0]??'');
  // An editing verb owns its complete argument, not arbitrary prose after a
  // closing quotation. Later clauses still need independent inactive proof.
  if(ranges.length) {
    if(ranges.length!==1)return false;
    const first=clauses[0]!,range=ranges[0]!;
    return /^\s*(?:请|帮我|替我|麻烦|只要|仅|先)*(?:改写|润色|翻译|转述|复述|校对|编辑|摘录|引用|记录)(?:一下|这句|这段|以下|原话|文字)?$/.test(first.slice(0,range.start))
      && /^(?:这句话|这段话|这段原话|作为背景|作为记录)?$/.test(first.slice(range.end));
  }
  return true;
}
export function quoteDisposition(options: { message: string; knownNames: readonly string[] },scope: InactiveSourceSpan,payloads: readonly InactiveSourceSpan[]=[]): 'instruction'|'unresolved_argument'|'none' {
  let unresolved=false,instruction=false;
  for(const range of quotedRanges(options.message)) {
    if(scope.start>=range.end||scope.end<=range.start)continue;
    if(!completeQuote(options.message,range))return 'unresolved_argument';
    if(payloads.some(payload=>range.start+1===payload.start&&range.end-1===payload.end&&options.message.slice(payload.start,payload.end)===payload.text))continue;
    const width=options.message.startsWith('```',range.start)?3:1;
    const content=options.message.slice(range.start+width,range.end-width);
    if(width===1&&options.knownNames.includes(content))continue;
    if((scope.start>=range.start&&scope.end<=range.end)||/转账|转给|汇给|打给|付款|赎回|赎出|挂失|恢复|解挂|取消|阻止|停止|终止|查询|查看|给.+(?:元|块)|[0-9]+\s*(?:元|块)/.test(content)||/^查(?:本月|上月|上个月|这个月|当月|账单|银行卡|卡片|理财|持仓|订阅|资金|余额|\d{4}[-/年])/.test(requestHead(content)))instruction=true;
    else unresolved=true;
  }
  // A broad quoted/history label cannot swallow a current query, even though
  // the query caller does not use the payment-specific passive guard.
  if((instruction||dataTaskPrefix.test(scope.text)||historicalPrefix.test(scope.text))&&currentInstructionOutsideQuotes(scope.text))return 'unresolved_argument';
  if(instruction&&!inactiveSourceSupported(scope.text,'historical')&&!explicitlyDataOnly(options.message,scope)&&!completeExample(scope.text))return 'unresolved_argument';
  return instruction?'instruction':unresolved?'unresolved_argument':'none';
}
export function inactiveSourceSupported(text: string,disposition: 'negated'|'historical'): boolean {
  const clauses=sourceClauses(text);
  if(!clauses.length||quotedRanges(text).some(range=>!completeQuote(text,range))||currentInstructionOutsideQuotes(text))return false;
  return clauses.every(clause=>{
    if(/^(?:我|请|也|今天|先|暂时|现在|这次|本次)*(?:不要|不用|不必|无需|不需要|暂不|先不|不再|不打算|不想|不准备|别|撤回|撤销|暂缓|不(?:转账|付款|支付|赎回|挂失|恢复|取消|阻止|查询|查看))/.test(clause))return true;
    if(/^(?:那句|这句|该句)(?:话)?(?:现在|已经)?(?:作废|撤回|不适用)(?:了)?$|^我还没决定(?:要不要|是否)[^，,。；;]*$|^(?:这里|这|我)?(?:只|仅)(?:是)?(?:在)?(?:说明|转述|记录|保存|存个)[^，,。；;]*(?:旧稿|笔记|背景|原话)$/.test(clause))return true;
    if(/^(?:我)?(?:只|仅)(?:是)?(?:把)?(?:这句|这段|上述)?(?:原话|文字|记录|笔记)?(?:贴在|放在|记在|保存到|存到)(?:这里|此处)(?:存个|作为|用于)?(?:背景|记录)?$/.test(clause))return true;
    if(/^(?:这|那|上述)(?:只|仅)(?:是)?(?:文档|历史|旧稿|笔记)(?:引用|记录|背景)$|^我(?:并)?没有丢卡$/.test(clause))return true;
    const ranges=quotedRanges(clause);
    if(ranges.length===1) {
      const range=ranges[0]!,before=clause.slice(0,range.start),after=clause.slice(range.end);
      const legacyPrefix=/^(?:我(?:在)?|上次|会议|培训|文档|旧账单|草稿|演示稿|记录|笔记|里|中|的|有一句|例句是|写了|看到了|是|原话|中的|备注)*$/;
      if((!before||historyQuotePrefix.test(before)||legacyPrefix.test(before))&&/^(?:这(?:几|些)个字)?(?:只是|仅是)?(?:我写给自己的)?(?:草案|文档引用|旧稿)?(?:已经)?(?:不适用|作废)?(?:了)?$/.test(after))return true;
    }
    return disposition==='historical'&&/^(?:历史记录[：:]?|账单(?:记录|记载)|以前|曾经|已经)/.test(clause);
  });
}
