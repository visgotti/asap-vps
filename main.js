function X(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var _=X();function ke(a){_=a}var E={exec:()=>null};function T(a){let e=[];return t=>{let r=Math.max(0,Math.min(3,t-1)),s=e[r];return s||(s=a(r),e[r]=s),s}}function p(a,e=""){let t=typeof a=="string"?a:a.source,r={replace:(s,i)=>{let o=typeof i=="string"?i:i.source;return o=o.replace(y.caret,"$1"),t=t.replace(s,o),r},getRegex:()=>new RegExp(t,e)};return r}var st=((a="")=>{try{return!!new RegExp("(?<=1)(?<!1)"+a)}catch{return!1}})(),y={codeRemoveIndent:/^(?: {0,3}\t| {1,4})/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,endingSpaceTabChar:/[ \t]$/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,leadingSpaceTab:/^[ \t]+/,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,numericCharacterReference:/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:a=>new RegExp(`^( {0,3}${a})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:T(a=>new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)),hrRegex:T(a=>new RegExp(`^ {0,${a}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)),fencesBeginRegex:T(a=>new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)),headingBeginRegex:T(a=>new RegExp(`^ {0,${a}}#`)),htmlBeginRegex:T(a=>new RegExp(`^ {0,${a}}(?:</?(?:${G})(?: +|$|/?>)|<(?:script|pre|style|textarea|!--))`,"i")),blockquoteBeginRegex:T(a=>new RegExp(`^ {0,${a}}>`))},rt=/^(?:[ \t]*(?:\n|$))+/,nt=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,it=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,V=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,ot=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,ee=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Se=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Ae=p(Se).replace(/bull/g,ee).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,"").getRegex(),lt=p(Se).replace(/bull/g,ee).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),te=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/,ct=/^[^\n]+/,ae=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,dt=p(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label",ae).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),ht=p(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g,ee).getRegex(),G="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",se=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,pt=p("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))","i").replace("comment",se).replace("tag",G).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),xe=a=>p(te).replace("hr",V).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list",a).replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",G).getRegex(),ut=xe(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/),mt=xe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/),gt=p(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",mt).getRegex(),re={blockquote:gt,code:nt,def:dt,fences:it,heading:ot,hr:V,html:pt,lheading:Ae,list:ht,newline:rt,paragraph:ut,table:E,text:ct},de=p("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",V).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code","(?: {4}| {0,3}	)[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",G).getRegex(),ft={...re,lheading:lt,table:de,paragraph:p(te).replace("hr",V).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",de).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",G).getRegex()},wt={...re,html:p(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment",se).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:E,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:p(te).replace("hr",V).replace("heading",` *#{1,6} *[^
]`).replace("lheading",Ae).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},vt=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,yt=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,Pe=/^( {2,}|\\)\n(?!\s*$)[ \t]*/,bt=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,x=/[\p{P}\p{S}]/u,R=/[\s\p{P}\p{S}]/u,N=/[^\s\p{P}\p{S}]/u,kt=p(/^((?![*_])punctSpace)/,"u").replace(/punctSpace/g,R).getRegex(),St=/[\p{Pi}\p{Ps}"']/u,Ie=/(?!~)[\p{P}\p{S}]/u,At=/(?!~)[\s\p{P}\p{S}]/u,xt=/(?:[^\s\p{P}\p{S}]|~)/u,Pt=p(/link|precode-code|html/,"g").replace("link",/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-",st?"(?<!`)()":"(^^|[^`])").replace("code",/(?<b>`+)[^`]+\k<b>(?!`)/).replace("html",/<(?! )[^<>]*?>/).getRegex(),Ee=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,It=p(Ee,"u").replace(/punct/g,x).getRegex(),Et=p(Ee,"u").replace(/punct/g,Ie).getRegex(),Ot=/^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/,_t=p(Ot,"u").replace(/openQuote/g,St).replace(/punct/g,x).getRegex(),Oe="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",Ct=p(Oe,"gu").replace(/notPunctSpace/g,N).replace(/punctSpace/g,R).replace(/punct/g,x).getRegex(),Tt=p(Oe,"gu").replace(/notPunctSpace/g,xt).replace(/punctSpace/g,At).replace(/punct/g,Ie).getRegex(),Rt="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)",$t=p(Rt,"gu").replace(/notPunctSpace/g,N).replace(/punctSpace/g,R).replace(/punct/g,x).getRegex(),Dt=p("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)","gu").replace(/notPunctSpace/g,N).replace(/punctSpace/g,R).replace(/punct/g,x).getRegex(),Lt="^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)",Ut=p(Lt,"gu").replace(/notPunctSpace/g,N).replace(/punctSpace/g,R).replace(/punct/g,x).getRegex(),Kt=p(/^~~?(?:((?!~)punct)|[^\s~])/,"u").replace(/punct/g,x).getRegex(),zt="^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",Vt=p(zt,"gu").replace(/notPunctSpace/g,N).replace(/punctSpace/g,R).replace(/punct/g,x).getRegex(),Gt=p(/\\(punct)/,"gu").replace(/punct/g,x).getRegex(),Nt=p(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),Ht=p(se).replace("(?:-->|$)","-->").getRegex(),Wt=p("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",Ht).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),_e=/\[(?:\\[\s\S]|[^\[\]\\])*\]/,B=p(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets",_e).getRegex(),Bt=p(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label",B).replace("href",/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),Mt=p(/^!?\[(label)\]\[(ref)\]/).replace("label",B).replace("ref",ae).getRegex(),Yt=p(/^!?\[(ref)\](?:\[\])?/).replace("ref",ae).getRegex(),he=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/,jt=p(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets",_e).getRegex(),Ft=p("reflink|nolink(?!\\()","g").replace("reflink",p(/^!?\[(label)\]\[(ref)\]/).replace("label",jt).replace("ref",he).getRegex()).replace("nolink",p(/^!?\[(ref)\](?:\[\])?/).replace("ref",he).getRegex()).getRegex(),pe=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,qt=/[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,Zt=p(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g,qt).getRegex(),ne={_backpedal:E,anyPunctuation:Gt,autolink:Nt,blockSkip:Pt,br:Pe,code:yt,del:E,delLDelim:E,delRDelim:E,emStrongLDelim:It,emStrongRDelimAst:Ct,emStrongRDelimUnd:Dt,escape:vt,link:Bt,nolink:Yt,punctuation:kt,reflink:Mt,reflinkSearch:Ft,tag:Wt,text:bt,url:E},Qt={...ne,emStrongLDelim:_t,emStrongRDelimAst:$t,emStrongRDelimUnd:Ut,link:p(/^!?\[(label)\]\((.*?)\)/).replace("label",B).getRegex(),reflink:p(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",B).getRegex()},Z={...ne,emStrongRDelimAst:Tt,emStrongLDelim:Et,delLDelim:Kt,delRDelim:Vt,url:p(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol",Zt).replace("protocol",pe).replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:p(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol",pe).replace(/emailProtocol/g,/(?:mailto|xmpp):/).getRegex()},Jt={...Z,br:p(Pe).replace("{2,}","*").getRegex(),text:p(Z.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},W={normal:re,gfm:ft,pedantic:wt},K={normal:ne,gfm:Z,breaks:Jt,pedantic:Qt},Xt={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},ue=a=>Xt[a];function k(a,e){if(e){if(y.escapeTest.test(a))return a.replace(y.escapeReplace,ue)}else if(y.escapeTestNoEncode.test(a))return a.replace(y.escapeReplaceNoEncode,ue);return a}function ea(a){return a.replace(y.numericCharacterReference,(e,t,r)=>{let s=t===void 0?Number.parseInt(r,16):Number.parseInt(t,10);return s===0||s>1114111||s>=55296&&s<=57343?"\uFFFD":String.fromCodePoint(s)})}function me(a){try{a=encodeURI(a).replace(y.percentDecode,"%")}catch{return null}return a}function ge(a,e){let t=a.replace(y.findPipe,(i,o,n)=>{let l=!1,c=o;for(;--c>=0&&n[c]==="\\";)l=!l;return l?"|":" |"}),r=t.split(y.splitPipe),s=0;if(r[0].trim()||r.shift(),r.length>0&&!r.at(-1)?.trim()&&r.pop(),e)if(r.length>e)r.splice(e);else for(;r.length<e;)r.push("");for(;s<r.length;s++)r[s]=r[s].trim().replace(y.slashPipe,"|");return r}function I(a,e,t){let r=a.length;if(r===0)return"";let s=0;for(;s<r;){let i=a.charAt(r-s-1);if(i===e&&!t)s++;else if(i!==e&&t)s++;else break}return a.slice(0,r-s)}function fe(a){let e=a.split(`
`),t=e.length-1;for(;t>=0&&y.blankLine.test(e[t]);)t--;return e.length-t<=2?a:e.slice(0,t+1).join(`
`)}function M(a){return a.trim().toLowerCase().toUpperCase().toLowerCase()}function we(a,e){if(a.indexOf(e[0])===-1&&a.indexOf(e[1])===-1)return-1;let t=0;for(let r=0;r<a.length;r++)if(a[r]==="\\")r++;else if(a[r]===e[0])t++;else if(a[r]===e[1]&&(t--,t<0))return r;return t>0?-2:-1}function ve(a,e=0){let t=e,r="";for(let s of a)if(s==="	"){let i=4-t%4;r+=" ".repeat(i),t+=i}else r+=s,t++;return r}function ye(a,e,t,r,s){let i=e.href,o=e.title||null,n=a[1].replace(s.other.outputLinkReplace,"$1"),l=a[0].charAt(0)==="!";r.state.inLink=!0;let c=r.state.linkEmitted,d=r.state.inRawBlock;r.state.linkEmitted=!1;let h=r.inlineTokens(n),f=r.state.linkEmitted;if(r.state.linkEmitted=c,r.state.inLink=!1,!l){if(f){r.state.inRawBlock=d;return}r.state.linkEmitted=!0}return{type:l?"image":"link",raw:t,href:i,title:o,text:n,tokens:h}}function ta(a,e,t){let r=a.match(t.other.indentCodeCompensation);if(r===null)return e;let s=r[1];return e.split(`
`).map(i=>{let o=i.match(t.other.beginningSpace);if(o===null)return i;let[n]=o;return i.slice(Math.min(n.length,s.length))}).join(`
`)}function be(a,e,t,r){if(!e.includes("<"))return!1;for(let s=0;s<e.length;s++){if(e[s]==="\\"){s++;continue}if(e[s]==="`"){let n=r.inline.code.exec(e.slice(s));if(n){s+=n[0].length-1;continue}}if(e[s]!=="<")continue;let i=a.slice(t+s),o=r.inline.tag.exec(i)||r.inline.autolink.exec(i);if(o){if(o[0].length>e.length-s)return!0;s+=o[0].length-1}}return!1}var Y=class{options;rules;lexer;constructor(a){this.options=a||_}space(a){let e=this.rules.block.newline.exec(a);if(e&&e[0].length>0)return{type:"space",raw:e[0]}}code(a){let e=this.rules.block.code.exec(a);if(e){let t=this.options.pedantic?e[0]:fe(e[0]),r=t.replace(this.rules.other.codeRemoveIndent,"");return{type:"code",raw:t,codeBlockStyle:"indented",text:r}}}fences(a){let e=this.rules.block.fences.exec(a);if(e){let t=e[0],r=ta(t,e[3]||"",this.rules);return{type:"code",raw:t,lang:e[2]?e[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):e[2],text:r}}}heading(a){let e=this.rules.block.heading.exec(a);if(e){let t=e[2].trim();if(this.rules.other.endingHash.test(t)){let r=I(t,"#");(this.options.pedantic||!r||this.rules.other.endingSpaceTabChar.test(r))&&(t=r.trim())}return{type:"heading",raw:I(e[0],`
`),depth:e[1].length,text:t,tokens:this.lexer.inline(t)}}}hr(a){let e=this.rules.block.hr.exec(a);if(e)return{type:"hr",raw:I(e[0],`
`)}}blockquote(a){let e=this.rules.block.blockquote.exec(a);if(e){let t=I(e[0],`
`).split(`
`),r="",s="",i=[];for(;t.length>0;){let o=!1,n=[],l;for(l=0;l<t.length;l++)if(this.rules.other.blockquoteStart.test(t[l]))n.push(t[l]),o=!0;else if(!o)n.push(t[l]);else break;t=t.slice(l);let c=n.join(`
`),d=c.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,"");r=r?`${r}
${c}`:c,s=s?`${s}
${d}`:d;let h=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(d,i,!0),this.lexer.state.top=h,t.length===0)break;let f=i.at(-1);if(f?.type==="code")break;if(f?.type==="blockquote"){let v=f,g=t.join(`
`),b=v.raw+`
`+g.replace(this.rules.other.blockquoteSetextReplace2,""),w=this.blockquote(b);i[i.length-1]=w;let C=b.substring(w.raw.length).replace(/^\n/,""),D=C?C.split(`
`).length:0,L=D?t.slice(0,-D):t;L.length>0&&(r=`${r}
${L.join(`
`)}`),s=s.substring(0,s.length-v.text.length)+w.text;break}else if(f?.type==="list"){let v=f,g=v.raw+`
`+t.join(`
`),b=this.list(g);i[i.length-1]=b,r=r.substring(0,r.length-f.raw.length)+b.raw,s=s.substring(0,s.length-v.raw.length)+b.raw,t=g.substring(i.at(-1).raw.length).split(`
`);continue}}return{type:"blockquote",raw:r,tokens:i,text:s}}}list(a){let e=this.rules.block.list.exec(a);if(e){let t=e[1].trim(),r=t.length>1,s={type:"list",raw:"",ordered:r,start:r?+t.slice(0,-1):"",loose:!1,items:[]};t=r?`\\d{1,9}\\${t.slice(-1)}`:`\\${t}`,this.options.pedantic&&(t=r?t:"[*+-]");let i=this.rules.other.listItemRegex(t),o=!1;for(;a;){let l=!1,c="",d="";if(!(e=i.exec(a))||this.rules.block.hr.test(a))break;c=e[0],a=a.substring(c.length);let h=e[2].split(`
`,1)[0],f=e[1].length,v=this.options.pedantic?ve(h,f):h.replace(this.rules.other.leadingSpaceTab,C=>ve(C,f)),g=a.split(`
`,1)[0],b=!v.trim(),w=0;if(this.options.pedantic?(w=2,d=v.trimStart()):b?w=f+1:(w=v.search(this.rules.other.nonSpaceChar),w=w>4?1:w,d=v.slice(w),w+=f),b&&this.rules.other.blankLine.test(g)&&(c+=g+`
`,a=a.substring(g.length+1),l=!0),!l){let C=this.rules.other.nextBulletRegex(w),D=this.rules.other.hrRegex(w),L=this.rules.other.fencesBeginRegex(w),ce=this.rules.other.headingBeginRegex(w),et=this.rules.other.htmlBeginRegex(w),tt=this.rules.other.blockquoteBeginRegex(w);for(;a;){let q=a.split(`
`,1)[0],U;if(g=q,this.options.pedantic?(g=g.replace(this.rules.other.listReplaceNesting,"  "),U=g):U=g.replace(this.rules.other.leadingSpaceTab,at=>at.replace(this.rules.other.tabCharGlobal,"    ")),L.test(g)||ce.test(g)||et.test(g)||tt.test(g)||C.test(g)||D.test(g))break;if(U.search(this.rules.other.nonSpaceChar)>=w||!g.trim())d+=`
`+U.slice(w);else{if(b||v.replace(this.rules.other.tabCharGlobal,"    ").search(this.rules.other.nonSpaceChar)>=4||L.test(v)||ce.test(v)||D.test(v))break;d+=`
`+g}b=!g.trim(),c+=q+`
`,a=a.substring(q.length+1),v=U.slice(w)}}s.loose||(o?s.loose=!0:this.rules.other.doubleBlankLine.test(c)&&(o=!0)),s.items.push({type:"list_item",raw:c,task:!!this.options.gfm&&this.rules.other.listIsTask.test(d),loose:!1,text:d,tokens:[]}),s.raw+=c}let n=s.items.at(-1);if(n)n.raw=n.raw.trimEnd(),n.text=n.text.trimEnd();else return;s.raw=s.raw.trimEnd();for(let l of s.items)if(this.lexer.state.top=!1,l.tokens=this.lexer.blockTokens(l.text,[]),!s.loose){let c=l.tokens.filter(h=>h.type==="space"),d=c.length>0&&c.some(h=>this.rules.other.anyLine.test(h.raw));s.loose=d}for(let l of s.items){let c=l.tokens[0];if(l.task&&(c?.type==="text"||c?.type==="paragraph")){l.text=l.text.replace(this.rules.other.listReplaceTask,""),c.raw=c.raw.replace(this.rules.other.listReplaceTask,""),c.text=c.text.replace(this.rules.other.listReplaceTask,"");for(let h=this.lexer.inlineQueue.length-1;h>=0;h--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[h].src)){this.lexer.inlineQueue[h].src=this.lexer.inlineQueue[h].src.replace(this.rules.other.listReplaceTask,"");break}let d=this.rules.other.listTaskCheckbox.exec(l.raw);if(d){let h={type:"checkbox",raw:d[0]+" ",checked:d[0]!=="[ ]"};l.checked=h.checked,s.loose?l.tokens[0]&&["paragraph","text"].includes(l.tokens[0].type)&&"tokens"in l.tokens[0]&&l.tokens[0].tokens?(l.tokens[0].raw=h.raw+l.tokens[0].raw,l.tokens[0].text=h.raw+l.tokens[0].text,l.tokens[0].tokens.unshift(h)):l.tokens.unshift({type:"paragraph",raw:h.raw,text:h.raw,tokens:[h]}):l.tokens.unshift(h)}}else l.task&&(l.task=!1)}if(s.loose)for(let l of s.items){l.loose=!0;for(let c of l.tokens)c.type==="text"&&(c.type="paragraph")}return s}}html(a){let e=this.rules.block.html.exec(a);if(e){let t=fe(e[0]);return{type:"html",block:!0,raw:t,pre:e[1]==="pre"||e[1]==="script"||e[1]==="style",text:t}}}def(a){let e=this.rules.block.def.exec(a);if(e){if(!this.rules.other.startAngleBracket.test(e[2])&&we(e[2],"()")!==-1)return;let t=M(e[1]).replace(this.rules.other.multipleSpaceGlobal," "),r=e[2]?e[2].replace(this.rules.other.hrefBrackets,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",s=e[3]?e[3].substring(1,e[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):e[3];return{type:"def",tag:t,raw:I(e[0],`
`),href:r,title:s}}}table(a){let e=this.rules.block.table.exec(a);if(!e||!this.rules.other.tableDelimiter.test(e[2]))return;let t=ge(e[1]),r=e[2].replace(this.rules.other.tableAlignChars,"").split("|"),s=e[3]?.trim()?e[3].replace(this.rules.other.tableRowBlankLine,"").split(`
`):[],i={type:"table",raw:I(e[0],`
`),header:[],align:[],rows:[]};if(t.length===r.length){for(let o of r)this.rules.other.tableAlignRight.test(o)?i.align.push("right"):this.rules.other.tableAlignCenter.test(o)?i.align.push("center"):this.rules.other.tableAlignLeft.test(o)?i.align.push("left"):i.align.push(null);for(let o=0;o<t.length;o++)i.header.push({text:t[o],tokens:this.lexer.inline(t[o]),header:!0,align:i.align[o]});for(let o of s)i.rows.push(ge(o,i.header.length).map((n,l)=>({text:n,tokens:this.lexer.inline(n),header:!1,align:i.align[l]})));return i}}lheading(a){let e=this.rules.block.lheading.exec(a);if(e){let t=e[1].trim();return{type:"heading",raw:I(e[0],`
`),depth:e[2].charAt(0)==="="?1:2,text:t,tokens:this.lexer.inline(t)}}}paragraph(a){let e=this.rules.block.paragraph.exec(a);if(e){let t=e[1].charAt(e[1].length-1)===`
`?e[1].slice(0,-1):e[1];return{type:"paragraph",raw:e[0],text:t,tokens:this.lexer.inline(t)}}}text(a){let e=this.rules.block.text.exec(a);if(e)return{type:"text",raw:e[0],text:e[0],tokens:this.lexer.inline(e[0])}}escape(a){let e=this.rules.inline.escape.exec(a);if(e)return{type:"escape",raw:e[0],text:e[1]}}tag(a){let e=this.rules.inline.tag.exec(a);if(e)return!this.lexer.state.inLink&&this.rules.other.startATag.test(e[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(e[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(e[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(e[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:e[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:e[0]}}link(a){if(this.lexer.state.linkParenPossible===!1)return;let e=this.rules.inline.link.exec(a);if(e){let t=e[0].charAt(0)==="!"?2:1;if(!this.options.pedantic&&be(a,e[1],t,this.rules))return;let r=e[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(r)){if(!this.rules.other.endAngleBracket.test(r))return;let o=I(r.slice(0,-1),"\\");if((r.length-o.length)%2===0)return}else{let o=we(e[2],"()");if(o===-2)return;if(o>-1){let n=(e[0].indexOf("!")===0?5:4)+e[1].length+o;e[2]=e[2].substring(0,o),e[0]=e[0].substring(0,n).trim(),e[3]=""}}let s=e[2],i="";if(this.options.pedantic){let o=this.rules.other.pedanticHrefTitle.exec(s);o&&(s=o[1],i=o[3])}else i=e[3]?e[3].slice(1,-1):"";return s=s.trim(),this.rules.other.startAngleBracket.test(s)&&(this.options.pedantic&&!this.rules.other.endAngleBracket.test(r)?s=s.slice(1):s=s.slice(1,-1)),ye(e,{href:s&&s.replace(this.rules.inline.anyPunctuation,"$1"),title:i&&i.replace(this.rules.inline.anyPunctuation,"$1")},e[0],this.lexer,this.rules)}}reflink(a,e){let t;if((t=this.rules.inline.reflink.exec(a))||(t=this.rules.inline.nolink.exec(a))){let r=t[0].charAt(0)==="!"?2:1;if(!this.options.pedantic&&be(a,t[1],r,this.rules))return;let s=(t[2]||t[1]).replace(this.rules.other.multipleSpaceGlobal," "),i=e[M(s)];if(!i){let o=t[0].charAt(0);return{type:"text",raw:o,text:o}}return ye(t,i,t[0],this.lexer,this.rules)}}emStrong(a,e,t=""){let r=this.rules.inline.emStrongLDelim.exec(a);if(!(!r||!r[1]&&!r[2]&&!r[3]&&!r[4]||r[4]&&t.match(this.rules.other.unicodeAlphaNumeric))&&(!(r[1]||r[3])||!t||this.rules.inline.punctuation.exec(t))){let s=[...r[0]].length-1,i,o,n=s,l=0,c=r[0][0],d=t===c,h=c==="*"?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(h.lastIndex=0,e=e.slice(-1*a.length+s);(r=h.exec(e))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i)continue;if(o=[...i].length,r[3]||r[4]){n+=o;continue}else if(r[5]||r[6]){if(s%3&&!((s+o)%3)){l+=o;continue}if(d)break}if(n-=o,n>0)continue;o=Math.min(o,o+n+l);let f=[...r[0]][0].length,v=a.slice(0,s+r.index+f+o);if(Math.min(s,o)%2){let b=v.slice(1,-1);return{type:"em",raw:v,text:b,tokens:this.lexer.inlineTokens(b)}}let g=v.slice(2,-2);return{type:"strong",raw:v,text:g,tokens:this.lexer.inlineTokens(g)}}}}codespan(a){let e=this.rules.inline.code.exec(a);if(e){let t=e[2].replace(this.rules.other.newLineCharGlobal," "),r=this.rules.other.nonSpaceChar.test(t),s=this.rules.other.startingSpaceChar.test(t)&&this.rules.other.endingSpaceChar.test(t);return r&&s&&(t=t.substring(1,t.length-1)),{type:"codespan",raw:e[0],text:t}}}br(a){let e=this.rules.inline.br.exec(a);if(e)return{type:"br",raw:e[0]}}del(a,e,t=""){let r=this.rules.inline.delLDelim.exec(a);if(r&&(!r[1]||!t||this.rules.inline.punctuation.exec(t))){let s=[...r[0]].length-1,i,o,n=s,l=this.rules.inline.delRDelim;for(l.lastIndex=0,e=e.slice(-1*a.length+s);(r=l.exec(e))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i||(o=[...i].length,o!==s))continue;if(r[3]||r[4]){n+=o;continue}if(n-=o,n>0)continue;o=Math.min(o,o+n);let c=[...r[0]][0].length,d=a.slice(0,s+r.index+c+o),h=d.slice(s,-s);return{type:"del",raw:d,text:h,tokens:this.lexer.inlineTokens(h)}}}}autolink(a){let e=this.rules.inline.autolink.exec(a);if(e){let t,r;return e[2]==="@"?(t=e[1],r="mailto:"+t):(t=e[1],r=t),{type:"link",raw:e[0],text:t,href:r,autolink:!0,tokens:[{type:"text",raw:t,text:t}]}}}url(a){let e;if(e=this.rules.inline.url.exec(a)){let t,r;if(e[2]==="@")t=e[0],r="mailto:"+t;else{let s;do s=e[0],e[0]=this.rules.inline._backpedal.exec(e[0])?.[0]??"";while(s!==e[0]);t=e[0],e[1]==="www."?r="http://"+e[0]:r=e[0]}return{type:"link",raw:e[0],text:t,href:r,autolink:!0,tokens:[{type:"text",raw:t,text:t}]}}}inlineText(a){let e=this.rules.inline.text.exec(a);if(e){let t=this.lexer.state.inRawBlock;return{type:"text",raw:e[0],text:t?e[0]:ea(e[0]),escaped:t}}}},S=class Q{tokens;options;state;inlineQueue;tokenizer;constructor(e){this.tokens=[],this.tokens.links=Object.create(null),this.options=e||_,this.options.tokenizer=this.options.tokenizer||new Y,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,linkEmitted:!1,linkParenPossible:!0,top:!0};let t={other:y,block:W.normal,inline:K.normal};this.options.pedantic?(t.block=W.pedantic,t.inline=K.pedantic):this.options.gfm&&(t.block=W.gfm,this.options.breaks?t.inline=K.breaks:t.inline=K.gfm),this.tokenizer.rules=t}static get rules(){return{block:W,inline:K}}static lex(e,t){return new Q(t).lex(e)}static lexInline(e,t){return new Q(t).inlineTokens(e)}lex(e){e=e.replace(y.carriageReturn,`
`),this.blockTokens(e,this.tokens);for(let t=0;t<this.inlineQueue.length;t++){let r=this.inlineQueue[t];this.inlineTokens(r.src,r.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[],r=!1){this.tokenizer.lexer=this,this.options.pedantic&&(e=e.replace(y.tabCharGlobal,"    ").replace(y.spaceLine,""));let s=1/0;for(;e;){if(e.length<s)s=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(n=>(i=n.call({lexer:this},e,t))?(e=e.substring(i.raw.length),t.push(i),!0):!1))continue;if(i=this.tokenizer.space(e)){e=e.substring(i.raw.length);let n=t.at(-1);i.raw.length===1&&n!==void 0?n.raw+=`
`:t.push(i);continue}if(i=this.tokenizer.code(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type==="paragraph"||n?.type==="text"?(n.raw+=(n.raw.endsWith(`
`)?"":`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(i=this.tokenizer.fences(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.heading(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.hr(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.blockquote(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.list(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.html(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.def(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type==="paragraph"||n?.type==="text"?(n.raw+=(n.raw.endsWith(`
`)?"":`
`)+i.raw,n.text+=`
`+i.raw,this.inlineQueue.at(-1).src=n.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},t.push(i));continue}if(i=this.tokenizer.table(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.lheading(e)){e=e.substring(i.raw.length),t.push(i);continue}let o=e;if(this.options.extensions?.startBlock){let n=1/0,l=e.slice(1),c;this.options.extensions.startBlock.forEach(d=>{c=d.call({lexer:this},l),typeof c=="number"&&c>=0&&(n=Math.min(n,c))}),n<1/0&&n>=0&&(o=e.substring(0,n+1))}if(this.state.top&&(i=this.tokenizer.paragraph(o))){let n=t.at(-1);r&&n?.type==="paragraph"?(n.raw+=(n.raw.endsWith(`
`)?"":`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i),r=o.length!==e.length,e=e.substring(i.raw.length);continue}if(i=this.tokenizer.text(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type==="text"?(n.raw+=(n.raw.endsWith(`
`)?"":`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}linkInText(e){if(!e.includes("["))return!1;let t=this.tokenizer.rules.inline.link;for(let r of e.matchAll(this.tokenizer.rules.inline.blockSkip))if(t.test(r[0])&&e.charAt(r.index-1)!=="!")return!0;for(let r of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)){let s=r[0],i=s.lastIndexOf("[");if(!(s.charAt(0)==="!"||!Object.hasOwn(this.tokens.links,M(s.slice(i+1,-1))))&&!(i>1&&this.linkInText(s.slice(1,i-1))))return!0}return!1}inlineTokens(e,t=[]){this.tokenizer.lexer=this;let r=this.state.linkParenPossible;this.state.linkParenPossible=r&&e.includes(")");try{return this.#e(e,t)}finally{this.state.linkParenPossible=r}}#e(e,t){let r=e;if(this.tokens.links&&e.includes("[")){let n=this.tokenizer.rules.inline.reflinkSearch,l=c=>{let d=c.lastIndexOf("[");if(!Object.hasOwn(this.tokens.links,M(c.slice(d+1,-1))))return c;if(d>1&&c.charAt(0)!=="!"){let h=c.slice(1,d-1);if(this.linkInText(h))return"["+h.replace(n,l)+"]["+"a".repeat(c.length-d-2)+"]"}return"["+"a".repeat(c.length-2)+"]"};r=r.replace(n,l)}r=r.replace(this.tokenizer.rules.inline.anyPunctuation,n=>"+".repeat(n.length)),r=r.replace(this.tokenizer.rules.inline.blockSkip,(n,l,c)=>{let d=c?c.length:0;return n.slice(0,d)+"["+"a".repeat(n.length-d-2)+"]"}),r=this.options.hooks?.emStrongMask?.call({lexer:this},r)??r;let s=!1,i="",o=1/0;for(;e;){if(e.length<o)o=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}s||(i=""),s=!1;let n;if(this.options.extensions?.inline?.some(c=>(n=c.call({lexer:this},e,t))?(e=e.substring(n.raw.length),t.push(n),!0):!1))continue;if(n=this.tokenizer.escape(e)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.tag(e)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.link(e)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.reflink(e,this.tokens.links)){e=e.substring(n.raw.length);let c=t.at(-1);n.type==="text"&&c?.type==="text"?(c.raw+=n.raw,c.text+=n.text):t.push(n);continue}if(n=this.tokenizer.emStrong(e,r,i)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.codespan(e)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.br(e)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.del(e,r,i)){e=e.substring(n.raw.length),t.push(n);continue}if(n=this.tokenizer.autolink(e)){e=e.substring(n.raw.length),t.push(n);continue}if(!this.state.inLink&&(n=this.tokenizer.url(e))){e=e.substring(n.raw.length),t.push(n);continue}let l=e;if(this.options.extensions?.startInline){let c=1/0,d=e.slice(1),h;this.options.extensions.startInline.forEach(f=>{h=f.call({lexer:this},d),typeof h=="number"&&h>=0&&(c=Math.min(c,h))}),c<1/0&&c>=0&&(l=e.substring(0,c+1))}if(n=this.tokenizer.inlineText(l)){e=e.substring(n.raw.length),n.raw.slice(-1)!=="_"&&(i=n.raw.slice(-1)),s=!0;let c=t.at(-1);c?.type==="text"?(c.raw+=n.raw,c.text+=n.text):t.push(n);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return t}infiniteLoopError(e){let t="Infinite loop on byte: "+e;if(this.options.silent)console.error(t);else throw new Error(t)}},j=class{options;parser;constructor(a){this.options=a||_}space(a){return""}code({text:a,lang:e,escaped:t}){let r=(e||"").match(y.notSpaceStart)?.[0],s=a?a.replace(y.endingNewline,"")+`
`:"";return r?'<pre><code class="language-'+k(r)+'">'+(t?s:k(s,!0))+`</code></pre>
`:"<pre><code>"+(t?s:k(s,!0))+`</code></pre>
`}blockquote({tokens:a}){return`<blockquote>
${this.parser.parse(a)}</blockquote>
`}html({text:a}){return a}def(a){return""}heading({tokens:a,depth:e}){return`<h${e}>${this.parser.parseInline(a)}</h${e}>
`}hr(a){return`<hr>
`}list(a){let e=a.ordered,t=a.start,r="";for(let o=0;o<a.items.length;o++){let n=a.items[o];r+=this.listitem(n)}let s=e?"ol":"ul",i=e&&t!==1?' start="'+t+'"':"";return"<"+s+i+`>
`+r+"</"+s+`>
`}listitem(a){return`<li>${this.parser.parse(a.tokens)}</li>
`}checkbox({checked:a}){return"<input "+(a?'checked="" ':"")+'disabled="" type="checkbox"> '}paragraph({tokens:a}){return`<p>${this.parser.parseInline(a)}</p>
`}table(a){let e="",t="";for(let s=0;s<a.header.length;s++)t+=this.tablecell(a.header[s]);e+=this.tablerow({text:t});let r="";for(let s=0;s<a.rows.length;s++){let i=a.rows[s];t="";for(let o=0;o<i.length;o++)t+=this.tablecell(i[o]);r+=this.tablerow({text:t})}return r&&(r=`<tbody>${r}</tbody>`),`<table>
<thead>
`+e+`</thead>
`+r+`</table>
`}tablerow({text:a}){return`<tr>
${a}</tr>
`}tablecell(a){let e=this.parser.parseInline(a.tokens),t=a.header?"th":"td";return(a.align?`<${t} align="${a.align}">`:`<${t}>`)+e+`</${t}>
`}strong({tokens:a}){return`<strong>${this.parser.parseInline(a)}</strong>`}em({tokens:a}){return`<em>${this.parser.parseInline(a)}</em>`}codespan({text:a}){return`<code>${k(a,!0)}</code>`}br(a){return"<br>"}del({tokens:a}){return`<del>${this.parser.parseInline(a)}</del>`}link({href:a,title:e,text:t,tokens:r,autolink:s}){let i=s?k(t,!0):this.parser.parseInline(r),o=me(a);if(o===null)return i;a=k(o,s);let n='<a href="'+a+'"';return e&&(n+=' title="'+k(e)+'"'),n+=">"+i+"</a>",n}image({href:a,title:e,text:t,tokens:r}){r&&(t=this.parser.parseInline(r,this.parser.textRenderer));let s=me(a);if(s===null)return k(t);a=s;let i=`<img src="${k(a)}" alt="${k(t)}"`;return e&&(i+=` title="${k(e)}"`),i+=">",i}text(a){return"tokens"in a&&a.tokens?this.parser.parseInline(a.tokens):"escaped"in a&&a.escaped?a.text:k(a.text)}},ie=class{strong({text:a}){return a}em({text:a}){return a}codespan({text:a}){return a}del({text:a}){return a}html({text:a}){return a}text({text:a}){return a}link({text:a}){return""+a}image({text:a}){return""+a}br(){return""}checkbox({raw:a}){return a}},A=class J{options;renderer;textRenderer;constructor(e){this.options=e||_,this.options.renderer=this.options.renderer||new j,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new ie}static parse(e,t){return new J(t).parse(e)}static parseInline(e,t){return new J(t).parseInline(e)}parse(e){this.renderer.parser=this;let t="";for(let r=0;r<e.length;r++){let s=e[r];if(this.options.extensions?.renderers?.[s.type]){let o=s,n=this.options.extensions.renderers[o.type].call({parser:this},o);if(n!==!1||!["space","hr","heading","code","table","blockquote","list","checkbox","html","def","paragraph","text"].includes(o.type)){t+=n||"";continue}}let i=s;switch(i.type){case"space":{t+=this.renderer.space(i);break}case"hr":{t+=this.renderer.hr(i);break}case"heading":{t+=this.renderer.heading(i);break}case"code":{t+=this.renderer.code(i);break}case"table":{t+=this.renderer.table(i);break}case"blockquote":{t+=this.renderer.blockquote(i);break}case"list":{t+=this.renderer.list(i);break}case"checkbox":{t+=this.renderer.checkbox(i);break}case"html":{t+=this.renderer.html(i);break}case"def":{t+=this.renderer.def(i);break}case"paragraph":{t+=this.renderer.paragraph(i);break}case"text":{t+=this.renderer.text(i);break}default:{let o='Token with "'+i.type+'" type was not found.';if(this.options.silent)return console.error(o),"";throw new Error(o)}}}return t}parseInline(e,t=this.renderer){this.renderer.parser=this;let r="";for(let s=0;s<e.length;s++){let i=e[s];if(this.options.extensions?.renderers?.[i.type]){let n=this.options.extensions.renderers[i.type].call({parser:this},i);if(n!==!1||!["escape","html","link","image","checkbox","strong","em","codespan","br","del","text"].includes(i.type)){r+=n||"";continue}}let o=i;switch(o.type){case"escape":{r+=t.text(o);break}case"html":{r+=t.html(o);break}case"link":{r+=t.link(o);break}case"image":{r+=t.image(o);break}case"checkbox":{r+=t.checkbox(o);break}case"strong":{r+=t.strong(o);break}case"em":{r+=t.em(o);break}case"codespan":{r+=t.codespan(o);break}case"br":{r+=t.br(o);break}case"del":{r+=t.del(o);break}case"text":{r+=t.text(o);break}default:{let n='Token with "'+o.type+'" type was not found.';if(this.options.silent)return console.error(n),"";throw new Error(n)}}}return r}},z=class{options;block;constructor(a){this.options=a||_}static passThroughHooks=new Set(["preprocess","postprocess","processAllTokens","emStrongMask"]);static passThroughHooksRespectAsync=new Set(["preprocess","postprocess","processAllTokens"]);preprocess(a){return a}postprocess(a){return a}processAllTokens(a){return a}emStrongMask(a){return a}provideLexer(a=this.block){return a?S.lex:S.lexInline}provideParser(a=this.block){return a?A.parse:A.parseInline}},oe=class{defaults=X();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=A;Renderer=j;TextRenderer=ie;Lexer=S;Tokenizer=Y;Hooks=z;constructor(...a){this.use(...a)}walkTokens(a,e){let t=[];for(let r of a)switch(t=t.concat(e.call(this,r)),r.type){case"table":{let s=r;for(let i of s.header)t=t.concat(this.walkTokens(i.tokens,e));for(let i of s.rows)for(let o of i)t=t.concat(this.walkTokens(o.tokens,e));break}case"list":{let s=r;t=t.concat(this.walkTokens(s.items,e));break}default:{let s=r;this.defaults.extensions?.childTokens?.[s.type]?this.defaults.extensions.childTokens[s.type].forEach(i=>{let o=s[i].flat(1/0);t=t.concat(this.walkTokens(o,e))}):s.tokens&&(t=t.concat(this.walkTokens(s.tokens,e)))}}return t}use(...a){let e=this.defaults.extensions||{renderers:{},childTokens:{}};return a.forEach(t=>{let r={...t};if(r.async=this.defaults.async||r.async||!1,t.extensions&&(t.extensions.forEach(s=>{if(!s.name)throw new Error("extension name required");if("renderer"in s){let i=e.renderers[s.name];i?e.renderers[s.name]=function(...o){let n=s.renderer.apply(this,o);return n===!1&&(n=i.apply(this,o)),n}:e.renderers[s.name]=s.renderer}if("tokenizer"in s){if(!s.level||s.level!=="block"&&s.level!=="inline")throw new Error("extension level must be 'block' or 'inline'");let i=e[s.level];i?i.unshift(s.tokenizer):e[s.level]=[s.tokenizer],s.start&&(s.level==="block"?e.startBlock?e.startBlock.push(s.start):e.startBlock=[s.start]:s.level==="inline"&&(e.startInline?e.startInline.push(s.start):e.startInline=[s.start]))}"childTokens"in s&&s.childTokens&&(e.childTokens[s.name]=s.childTokens)}),r.extensions=e),t.renderer){let s=this.defaults.renderer||new j(this.defaults);for(let i in t.renderer){if(!(i in s))throw new Error(`renderer '${i}' does not exist`);if(["options","parser"].includes(i))continue;let o=i,n=t.renderer[o],l=s[o];s[o]=(...c)=>{let d=n.apply(s,c);return d===!1&&(d=l.apply(s,c)),d||""}}r.renderer=s}if(t.tokenizer){let s=this.defaults.tokenizer||new Y(this.defaults);for(let i in t.tokenizer){if(!(i in s))throw new Error(`tokenizer '${i}' does not exist`);if(["options","rules","lexer"].includes(i))continue;let o=i,n=t.tokenizer[o],l=s[o];s[o]=(...c)=>{let d=n.apply(s,c);return d===!1&&(d=l.apply(s,c)),d}}r.tokenizer=s}if(t.hooks){let s=this.defaults.hooks||new z;for(let i in t.hooks){if(!(i in s))throw new Error(`hook '${i}' does not exist`);if(["options","block"].includes(i))continue;let o=i,n=t.hooks[o],l=s[o];z.passThroughHooks.has(i)?s[o]=c=>{if(this.defaults.async&&z.passThroughHooksRespectAsync.has(i))return(async()=>{let h=await n.call(s,c);return l.call(s,h)})();let d=n.call(s,c);return l.call(s,d)}:s[o]=(...c)=>{if(this.defaults.async)return(async()=>{let h=await n.apply(s,c);return h===!1&&(h=await l.apply(s,c)),h})();let d=n.apply(s,c);return d===!1&&(d=l.apply(s,c)),d}}r.hooks=s}if(t.walkTokens){let s=this.defaults.walkTokens,i=t.walkTokens;r.walkTokens=function(o){let n=[];return n.push(i.call(this,o)),s&&(n=n.concat(s.call(this,o))),n}}this.defaults={...this.defaults,...r}}),this}setOptions(a){return this.defaults={...this.defaults,...a},this}lexer(a,e){return S.lex(a,e??this.defaults)}parser(a,e){return A.parse(a,e??this.defaults)}parseMarkdown(a){return(e,t)=>{let r={...t},s={...this.defaults,...r},i=this.onError(!!s.silent,!!s.async);if(this.defaults.async===!0&&r.async===!1)return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));if(typeof e>"u"||e===null)return i(new Error("marked(): input parameter is undefined or null"));if(typeof e!="string")return i(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(e)+", string expected"));if(s.hooks&&(s.hooks.options=s,s.hooks.block=a),s.async)return(async()=>{let o=s.hooks?await s.hooks.preprocess(e):e,n=await(s.hooks?await s.hooks.provideLexer(a):a?S.lex:S.lexInline)(o,s),l=s.hooks?await s.hooks.processAllTokens(n):n;s.walkTokens&&await Promise.all(this.walkTokens(l,s.walkTokens));let c=await(s.hooks?await s.hooks.provideParser(a):a?A.parse:A.parseInline)(l,s);return s.hooks?await s.hooks.postprocess(c):c})().catch(i);try{s.hooks&&(e=s.hooks.preprocess(e));let o=(s.hooks?s.hooks.provideLexer(a):a?S.lex:S.lexInline)(e,s);s.hooks&&(o=s.hooks.processAllTokens(o)),s.walkTokens&&this.walkTokens(o,s.walkTokens);let n=(s.hooks?s.hooks.provideParser(a):a?A.parse:A.parseInline)(o,s);return s.hooks&&(n=s.hooks.postprocess(n)),n}catch(o){return i(o)}}}onError(a,e){return t=>{if(t.message+=`
Please report this to https://github.com/markedjs/marked.`,a){let r="<p>An error occurred:</p><pre>"+k(t.message+"",!0)+"</pre>";return e?Promise.resolve(r):r}if(e)return Promise.reject(t);throw t}}},O=new oe;function m(a,e){return O.parse(a,e)}m.options=m.setOptions=function(a){return O.setOptions(a),m.defaults=O.defaults,ke(m.defaults),m};m.getDefaults=X;m.defaults=_;function aa(...a){return O.use(...a),m.defaults=O.defaults,ke(m.defaults),m}m.use=aa;m.walkTokens=function(a,e){return O.walkTokens(a,e)};m.parseInline=O.parseInline;m.Parser=A;m.parser=A.parse;m.Renderer=j;m.TextRenderer=ie;m.Lexer=S;m.lexer=S.lex;m.Tokenizer=Y;m.Hooks=z;m.parse=m;var Da=m.options,La=m.setOptions,Ua=m.walkTokens,Ka=m.parseInline;var za=A.parse,Va=S.lex;function sa(a){let e={},t=a.replace(/(\w+)="([^"]*)"/g,(i,o,n)=>(e[o]=n,"")),[r="",...s]=t.trim().split(/\s+/).filter(Boolean);return{lang:r,flags:new Set(s),attrs:e}}function Ce(a){return a.lang!=="ts"&&a.lang!=="typescript"||a.flags.has("static")?"static":a.flags.has("error")?"error":a.flags.has("run")?"run":"edit"}function Te(a,e){let t=[],r=/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;for(let s=r.exec(e);s;s=r.exec(e))t.push({id:`${a}#${t.length+1}`,...sa(s[1]),code:s[2].replace(/\n$/,"")});return t}var Re=`# asap-vps

Servers on any cloud, through one set of typed primitives: rent a VPS or a GPU server, log in over SSH, set it up, capture it as an image, delete it, the same way on every provider. Each provider is one class, and its type says exactly what it can do.

Every code block on this site is a real editor with the library's real types. Click into one and press \`Ctrl+Space\`: the completions, hover documentation and errors are the ones your editor gives you. The blocks marked **Simulated** have a **Run** button: they execute the library's actual code in your browser against in-memory fakes of each provider's API (nothing is rented, nothing leaves the page), on a clock that runs ahead so a ten-minute boot takes a moment. [How the sandbox works](#/sandbox) says exactly what is real and what is not.

\`\`\`ts run title="Rent a droplet, look at the bill, delete it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);

// what can be rented right now, cheapest first
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
console.log(\`\${offer.id}: $\${offer.pricePerHour}/h, in \${offer.regions.join(", ")}\`);

const server = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0] });
const running = await digitalOcean.waitUntilRunning(server.id);
console.log(running.status, running.ip);

console.log(await digitalOcean.getServerCost(server.id)); // counted the way DigitalOcean counts
await digitalOcean.deleteServerAndWait(server.id); // deletes, then checks until it is gone
\`\`\`

Try changing \`kind: "cpu"\` to \`kind: "gpu"\`, or put the cursor after \`digitalOcean.\` and look at what the type offers.

## Five providers, one interface

\`\`\`capabilities
\`\`\`

What a provider can do is a set of capabilities, each an interface. A class implements exactly the capabilities its platform has, so its type tells you what it can do: [Lambda](#/lambda) has no stop, so \`LambdaCloud\` has no \`stopServer\` to call. [Types and completion](#/types) shows that, and the options that are typed per platform too.

The table above is generated from the code every time the site is built.

## Where to go next

- [Quick start](#/quick-start): install, set the keys, and rent your first server.
- The providers: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway), [Lambda](#/lambda), [RunPod](#/runpod) and [Vast.ai](#/vast).
- The guides: [types and completion](#/types), [containers](#/containers), [images](#/images), [volumes](#/volumes), [serverless](#/serverless), [costs](#/costs) and [errors](#/errors).
- The [playground](#/playground): a blank file with every provider's fake behind it.
`;var $e=`# Quick start

## Install

\`\`\`bash
npm install asap-vps      # Node 18 or newer
\`\`\`

The library runs on Node (it uses the global \`fetch\`) and has one runtime dependency, \`node-ssh\`, for logging into the servers it rents.

## Keys

Each provider reads its API key from an environment variable, and \`providersFromEnv\` builds the ones you have. Leave the others unset.

| Provider | Class | Environment variable | Where to make the key |
|---|---|---|---|
| DigitalOcean | \`DigitalOcean\` | \`DIGITAL_OCEAN_API_KEY\` | API \u2192 Tokens \u2192 Generate New Token (Full Access) |
| Scaleway | \`Scaleway\` | \`SCW_SECRET_KEY\`, \`SCW_DEFAULT_PROJECT_ID\`, and \`SCW_ACCESS_KEY\` for image copy and import | IAM \u2192 API keys |
| Lambda Cloud | \`LambdaCloud\` | \`LAMBDA_API_KEY\` | API keys \u2192 Generate API key |
| RunPod | \`RunPod\` | \`RUNPOD_API_KEY\` | Settings \u2192 API Keys (All) |
| Vast.ai | \`VastAI\` | \`VAST_API_KEY\` | Account \u2192 API Keys |

In the sandbox on this site, \`process.env\` already holds a key each fake accepts: the snippets read the variables exactly as your code would.

## Your first server

One provider, from rent to delete:

\`\`\`ts run title="A GPU on RunPod"
import { CUDA_TYPES, MACHINE_TYPES, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const cuda = CUDA_TYPES.CUDA_12_8;

const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1, minCudaVersion: cuda }); // cheapest first
const server = await runpod.createServer({
  name: "my-gpu",
  offer, // brings its region and GPU count
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda }, // the library's names: the same on every provider
  command: ["sleep", "infinity"],
});
console.log((await runpod.waitUntilRunning(server.id)).status);
await runpod.deleteServerAndWait(server.id); // deletes, then checks until it is gone
\`\`\`

## One name for an image

\`image\` takes the library's names, and each provider sends its own for them: a \`MACHINE_TYPES\` member is that Ubuntu, and \`{ os, cuda }\` is that Ubuntu for a machine that runs CUDA software.

| \`image\` | RunPod, Vast, and any \`container\` | DigitalOcean | Scaleway | Lambda |
|---|---|---|---|---|
| \`MACHINE_TYPES.UBUNTU_24\` | \`ubuntu:24.04\` | \`ubuntu-24-04-x64\` | \`ubuntu_noble\` (types without GPUs) | \`ubuntu-24-04\` |
| \`{ os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 }\` | \`nvidia/cuda:12.8.2-base-ubuntu24.04\` | \`gpu-h100x1-base\` (\`gpu-h100x8-base\` on an x8 size) | \`ubuntu_noble_gpu_os_13_nvidia\` (GPU types) | \`lambda-stack-24-04\` |

A container gets NVIDIA's \`base\` image of that CUDA version's newest patch, and \`minCudaVersion\` defaults to the version, so it lands only on a host whose driver runs it. Given no command it runs \`sleep infinity\`, so it stays up as a VM does.

A VM gets the provider's GPU image of that Ubuntu: the one with the NVIDIA driver, which is what CUDA software needs of the machine. What else it carries is the provider's (DigitalOcean's the CUDA toolkit, Lambda's CUDA and the frameworks, Scaleway's Docker with NVIDIA's runtime), and the CUDA version asked for is not checked there.

What no image exists for is refused with \`NotSupportedError\` before anything is sent, never sent as it is: a CUDA version NVIDIA does not publish for that Ubuntu, an Ubuntu a provider has no image of, or a pair a provider cannot boot (Scaleway's plain Ubuntu on a GPU type, its GPU OS on a type without GPUs).

A provider's own name still passes as it is (a slug, an image id, a registry reference, an image from \`listImages\`): that is what an image of your own needs.

## The same question to every provider

Code that does not care which cloud it is on asks each configured provider the same thing, and the answers are comparable: an offer has the same fields everywhere.

\`\`\`ts run title="The cheapest 24 GB GPU, across every provider with a key"
import { providersFromEnv } from "asap-vps";

const rows = [];
for (const provider of providersFromEnv(process.env)) {
  const [cheapest] = await provider.listOffers({ kind: "gpu", minVramGb: 24 });
  if (cheapest) rows.push({ provider: provider.id, gpu: cheapest.gpu, vramGb: cheapest.vramGb, usdPerHour: Math.round(cheapest.pricePerHour * 100) / 100 });
}
rows.sort((a, b) => a.usdPerHour - b.usdPerHour);
console.log(rows);
\`\`\`

Where a machine is reads the same everywhere too. Each provider names its places its own way (\`tor1\`, \`fr-par-2\`, \`us-east-1\`, \`EU-RO-1\`, \`Texas, US\`), so every offer carries \`locations\`, its regions with the country each is in, and \`countries\` narrows a question to them:

\`\`\`ts run title="GPUs in the United States or Canada, on every provider"
import { COUNTRY_TYPES, providersFromEnv } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  const offers = await provider.listOffers({ kind: "gpu", countries: [COUNTRY_TYPES.US, COUNTRY_TYPES.CA] });
  const [cheapest] = offers;
  // its regions are only the ones in those countries: pass the offer to createServer and it is rented there
  if (cheapest) console.log(provider.id, cheapest.gpu, cheapest.locations);
}
\`\`\`

## Logging in

Every provider's server says where its sshd is and whom to log in as (\`root\`, or \`ubuntu\` on Lambda), a VM or a container, so the login is the same everywhere. This needs Node (sockets and key generation), so it is checked here but not run:

\`\`\`ts
import { DigitalOcean, RemoteMachine, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys(); // in process: nothing is written to disk
const key = await digitalOcean.addSSHKey(publicKey, "my_key"); // the same key again returns this registration

const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const server = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0], sshKeyIds: [key.id] });
const running = await digitalOcean.waitUntilRunning(server.id);

const machine = await RemoteMachine.connect(running, { privateKey });
console.log((await machine.run("uname -a")).stdout);
await machine.close();

await digitalOcean.deleteServerAndWait(server.id);
await digitalOcean.deleteSSHKey(key.id);
\`\`\`

What a \`RemoteMachine\` does once you are in (commands as the login or as root, files, a user of its own with its keys), and how to rent, log in and run a whole setup in one call, is under [Logging in and setting up](#/ssh).
`;var De=`# DigitalOcean

\`DigitalOcean\` rents **droplets**, with or without GPUs. It has the widest set of capabilities of the five: stop and start, restart, SSH keys, images with copy across regions and import from a URL, block volumes and shared NFS file storage, and attaching a volume to a running droplet.

\`\`\`ts run title="A droplet with cloud-init, from rent to delete"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);

// An SSH key of the account, registered once: the same key again returns this registration.
const key = await digitalOcean.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");

const [offer] = await digitalOcean.listOffers({ kind: "cpu", maxPricePerHour: 0.2 });
const server = await digitalOcean.createServer({
  name: "web-1",
  offer, // brings its own regions: nothing to repeat
  region: offer.regions[0],
  sshKeyIds: [key.id],
  userData: "#cloud-config\\npackages: [nginx]\\n", // cloud-init, run at the first boot
  tags: ["web"],
});

const running = await digitalOcean.waitUntilRunning(server.id);
console.log(\`\${running.name} is \${running.status} at \${running.ip}, in \${running.region}\`);
console.log("ssh:", running.ssh); // where its sshd is, and as whom to log in

await digitalOcean.deleteServerAndWait(server.id);
await digitalOcean.deleteSSHKey(key.id);
\`\`\`

\`createServer\` takes an \`offer\` from \`listOffers\`, or just an offer's id. Every record carries what DigitalOcean itself returned as \`raw\`, typed: \`running.raw\` is a \`DigitalOceanDropletData\`.

## A stopped droplet still bills

DigitalOcean keeps the droplet's CPU and memory reserved while it is off, so it bills as if it ran. The capability says so, and \`getServerCost\` follows it:

\`\`\`ts run title="Stop, start, and what it costs"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const server = await digitalOcean.createServer({ name: "batch-1", offer, region: offer.regions[0] });
await digitalOcean.waitUntilRunning(server.id);

console.log(DigitalOcean.capabilities.power); // { stoppedBilling: 'full' }

await digitalOcean.stopServer(server.id);
console.log((await digitalOcean.getServer(server.id))?.status);
console.log("cost while stopped:", await digitalOcean.getServerCost(server.id)); // the run goes on

await digitalOcean.startServer(server.id); // each returns once the droplet runs again
await digitalOcean.restartServer(server.id);
await digitalOcean.deleteServerAndWait(server.id);
\`\`\`

## Images: capture once, boot many

Capture a server's disk as an image, copy it to another region (a snapshot is region-bound), and boot a new server from it:

\`\`\`ts run title="Snapshot, copy to another region, boot from it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const source = await digitalOcean.createServer({ name: "golden", offer, region: offer.regions[0] });
await digitalOcean.waitUntilRunning(source.id);

await digitalOcean.stopServer(source.id); // for a consistent disk
const image = await digitalOcean.createImage(source.id, { name: "my-gpu-ready" }); // waits until available
console.log(image.name, image.status, "in", image.regions);

const other = offer.regions.find((r) => !image.regions.includes(r))!;
const copied = await digitalOcean.copyImage(image.id, [other]); // imageCopy
console.log("now in", copied.regions);

const next = await digitalOcean.createServer({ name: "from-image", offer, region: other, image: image.id });
console.log((await digitalOcean.waitUntilRunning(next.id)).status);

await digitalOcean.deleteServerAndWait(next.id);
await digitalOcean.deleteServerAndWait(source.id);
await digitalOcean.deleteImage(image.id); // idempotent
\`\`\`

An image built elsewhere (Packer, a distribution's cloud image) comes in with \`importImage\`. DigitalOcean fetches the file itself: raw, qcow2, vhdx, vdi or vmdk, gzip or bzip2 too, under 100 GB, from a host that answers HEAD. The image needs cloud-init and BIOS boot.

\`\`\`ts run title="Import Ubuntu's cloud image from its URL"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const noble = await digitalOcean.importImage({
  name: "noble-min",
  region: offer.regions[0], // the region droplets from it will run in
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
  providerOptions: { distribution: "Ubuntu" }, // typed: DigitalOcean's own distribution names
});
console.log(noble.name, noble.status, noble.regions, noble.raw.type);
await digitalOcean.deleteImage(noble.id);
\`\`\`

## Volumes: block, and shared over NFS

DigitalOcean makes both kinds. \`createVolume\` makes a block volume (one droplet at a time, formatted ext4, mounted by DigitalOcean at \`/mnt/<name>\`); \`shared: true\` makes an NFS share many droplets of its VPC mount at once, at a path of your choosing. The return type follows the option:

\`\`\`ts run title="A block volume, outliving the droplet that mounts it"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const region = offer.regions[0];

const disk = await digitalOcean.createVolume({ name: "models", region, sizeGb: 100 });
console.log(disk.name, disk.sizeGb, "GB, mounted at", disk.mountPath, "| shared:", disk.shared);

const server = await digitalOcean.createServer({ name: "trainer", offer, region, mounts: [{ volume: disk }] });
await digitalOcean.waitUntilRunning(server.id);
console.log((await digitalOcean.getVolume(disk.id))?.status); // attached

await digitalOcean.deleteServerAndWait(server.id); // the volume outlives it
console.log((await digitalOcean.getVolume(disk.id))?.status); // available
await digitalOcean.deleteVolume(disk.id);
\`\`\`

A volume on a running droplet is \`attachVolume\` / \`detachVolume\` (the \`volumeAttach\` capability).

An NFS share exists in \`nyc2\`, \`ams3\`, \`atl1\`, \`ric1\`, \`mkc1\` and \`mem1\`, so a droplet that mounts one is rented there. The library mounts it over NFS (cloud-init, fstab) at the path you give:

\`\`\`ts run title="An NFS share two droplets can mount"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const region = "nyc2";
const offer = (await digitalOcean.listOffers({ kind: "gpu" })).find((o) => o.regions.includes(region))!;

const share = await digitalOcean.createVolume({ name: "weights", region, sizeGb: 50, shared: true });
console.log(share.shared, share.sizeGb, "GB, status", share.status); // typed as an NFS share: share.raw.host, share.raw.mount_path

const mounts = [{ volume: share, path: "/models" }];
const a = await digitalOcean.createServer({ name: "worker-a", offer, region, mounts });
const b = await digitalOcean.createServer({ name: "worker-b", offer, region, mounts });
await Promise.all([a, b].map((s) => digitalOcean.waitUntilRunning(s.id)));
console.log(a.mounts, b.mounts); // [{ volumeId, path: '/models' }]

await Promise.all([a, b].map((s) => digitalOcean.deleteServerAndWait(s.id)));
await digitalOcean.deleteVolume(share.id);
\`\`\`

## Containers

A droplet is a VM, so \`container\` runs your image with Docker from cloud-init at the first boot, GPUs passed through where there are any. [Containers on any provider](#/containers) shows the same option on all five.

## Class hierarchy

\`DigitalOcean\` is a \`BaseProvider\`. Below is what that gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

\`\`\`heritage
digitalocean
\`\`\`
`;var Le=`# Scaleway

\`Scaleway\` rents **Instances**, with GPUs or without, and has the most Scaleway-shaped details of the five, all handled for you: everything is zonal (a server is named \`zone/uuid\`), creating anything needs your **Project**, and a stopped server frees its slot so only its volumes and addresses bill.

It takes the **secret key** of an API key and the Project. The **access key** is needed only where Object Storage is (image copy and import):

\`\`\`ts
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, // the secret key: sent as X-Auth-Token
  projectId: process.env.SCW_DEFAULT_PROJECT_ID!, // where servers and SSH keys are created
  accessKey: process.env.SCW_ACCESS_KEY, // only for image copy and import
  zones: "fr-par", // optional: only these zones (a region stands for its zones)
});
\`\`\`

## A server in a zone

\`\`\`ts run title="Rent the cheapest Instance, stop it, start it, delete it"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });

const [offer] = await scaleway.listOffers({ kind: "cpu" }); // cheapest first; its regions are zones with stock
console.log(\`\${offer.id}: $\${offer.pricePerHour.toFixed(4)}/h in \${offer.regions.join(", ")}\`);

const created = await scaleway.createServer({ name: "api-1", offer, region: offer.regions[0] });
const server = await scaleway.waitUntilRunning(created.id);
console.log(server.id, server.status, server.ip); // a zoned id: <zone>/<uuid>

await scaleway.stopServer(server.id); // poweroff, waited for: the slot is released
console.log("stopped, cost now:", await scaleway.getServerCost(server.id)); // null: only volumes and IPs bill
await scaleway.startServer(server.id); // needs stock again; returns once it runs
await scaleway.deleteServerAndWait(server.id); // also deletes the volumes it made
\`\`\`

Two things worth knowing, both seen on the live API: Scaleway applies **every SSH key of a Project at every boot** (so \`sshKeyIds\` must be the Project's keys, and deleting one locks it out at the next boot, \`capabilities.sshKeys.appliedAtBoot\`), and a GPU **quota starts at 0** until the account's identity is verified (\`QuotaError\`).

## Volumes: Block Storage and File Storage

A block volume is a disk one server holds. Scaleway attaches it but does not mount it: the server formats (when new) and mounts it (\`mount: 'device'\`). It outlives the server, and it can go onto a server that is already running:

\`\`\`ts run title="A block volume, attached to a running server"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
const [offer] = await scaleway.listOffers({ kind: "cpu" });
const zone = offer.regions[0];

const server = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "db-1", offer, region: zone })).id);
const disk = await scaleway.createVolume({ name: "pgdata", region: zone, sizeGb: 50 }); // 5000 IOPS Block Storage
console.log(disk.id, disk.status); // zone/uuid, available

await scaleway.attachVolume(disk.id, server.id); // the volumeAttach capability
console.log((await scaleway.getVolume(disk.id))?.status, (await scaleway.getVolume(disk.id))?.serverIds);

await scaleway.detachVolume(disk.id, server.id);
await scaleway.deleteServerAndWait(server.id);
await scaleway.deleteVolume(disk.id);
\`\`\`

\`shared: true\` makes a **File Storage** filesystem instead: many Instances mount one at once, with virtiofs, at a path you choose. File Storage is in Paris, and only some Instance types can attach one (\`max_file_systems\`: the POP2, L4, L40S and H100 families, among others):

\`\`\`ts run title="A shared filesystem two Instances mount at once"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
// the cheapest type, GPU or not, that can attach a filesystem and is in stock in Paris
const offer = (await scaleway.listOffers()).find(
  (o) => (o.raw.serverType.capabilities?.max_file_systems ?? 0) > 0 && o.regions.some((z) => z.startsWith("fr-par")),
)!;
const zone = offer.regions.find((z) => z.startsWith("fr-par"))!;

const share = await scaleway.createVolume({ name: "datasets", region: zone, sizeGb: 25, shared: true });
console.log(share.shared, share.region, share.status); // typed as a ScalewayFileSystem

const mounts = [{ volume: share, path: "/mnt/datasets" }];
const a = await scaleway.createServer({ name: "worker-a", offer, region: zone, mounts });
const b = await scaleway.createServer({ name: "worker-b", offer, region: zone, mounts });
await Promise.all([a, b].map((s) => scaleway.waitUntilRunning(s.id)));
console.log("attachments:", ((await scaleway.getVolume(share.id))?.raw as { number_of_attachments?: number }).number_of_attachments);

await Promise.all([a, b].map((s) => scaleway.deleteServerAndWait(s.id)));
await scaleway.deleteVolume(share.id);
\`\`\`

## Images: zone-bound, copied through Object Storage

Scaleway has no copy of its own. \`copyImage\` exports the root snapshot as a QCOW2 to a bucket, moves it (in parts, several at a time, so this machine holds only the parts in flight), imports it in each zone asked for and images it there. A copy is an image of its zone with the same name; \`createServer\` boots it when given the source's id and the copy's zone, and \`deleteImage\` deletes the copies with the source. It needs the API key's access key:

\`\`\`ts run title="Capture an image, copy it to another zone, boot it there"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});
const [offer] = await scaleway.listOffers({ kind: "cpu" });
const from = offer.regions[0];
const to = offer.regions.find((z) => z !== from) ?? "fr-par-2";

const source = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "golden", offer, region: from })).id);
await scaleway.stopServer(source.id);
const image = await scaleway.createImage(source.id, { name: "golden-v1" });
console.log(image.name, "in", image.regions);

const copied = await scaleway.copyImage(image.id, [to]); // imageCopy
console.log("now in", copied.regions);

const next = await scaleway.createServer({ name: "from-image", offer, region: to, image: image.id });
console.log((await scaleway.waitUntilRunning(next.id)).region); // the copy in \`to\` was booted

await scaleway.deleteServerAndWait(next.id);
await scaleway.deleteServerAndWait(source.id);
await scaleway.deleteImage(image.id); // the copies go with it
\`\`\`

An image built elsewhere comes in with \`importImage\`: a QCOW2 (unencrypted, no backing file, at most 1 TB) goes into a bucket made for it, is imported as a Block snapshot and imaged. It boots with UEFI and needs cloud-init. Where the file's server serves ranges, they stream straight into the bucket; this needs Node (it reads the network and a bucket), so the block is type-checked here, not run:

\`\`\`ts
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});
const noble = await scaleway.importImage({
  name: "noble-min",
  region: "fr-par-2",
  url: "https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
});
// An Ubuntu cloud image lets no key log in as root: boot it with
// userData: "#cloud-config\\ndisable_root: false"
console.log(noble.id, noble.regions);
\`\`\`

## Serverless containers

Scaleway Serverless Containers run one image on demand behind an HTTPS URL, from zero instances, on **CPU** only. Each endpoint gets a namespace made for it and deleted with it, and is private: the account's key goes as \`X-Auth-Token\`, to Scaleway's hosts only.

\`\`\`ts run title="An endpoint from zero, called with the account's key"
import { Scaleway } from "asap-vps";

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });

const [offer] = await scaleway.listEndpointOffers({ kind: "cpu" }); // sizes, priced per hour while an instance runs
const endpoint = await scaleway.createEndpoint({
  name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer, minWorkers: 0, maxWorkers: 2,
});
console.log(endpoint.url, endpoint.status, "private:", endpoint.private);

const response = await scaleway.requestEndpoint(endpoint, "/api"); // a cold start is waited out
console.log(response.status, await response.json());

await scaleway.deleteEndpoint(endpoint.id); // the namespace goes with it
\`\`\`

See [Serverless endpoints](#/serverless) for RunPod's, the same calls on a GPU.

## Class hierarchy

\`Scaleway\` is a \`BaseProvider\`. Below is what that gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

\`\`\`heritage
scaleway
\`\`\`
`;var Ue=`# Lambda Cloud

\`LambdaCloud\` rents **GPU VMs**. It is the smallest of the five on purpose: a Lambda instance can be restarted and deleted but not stopped, its filesystems are shared and grow as they fill, and it is GPU-only. Because the class implements exactly what the platform has, the compiler is the documentation: what Lambda cannot do is not on the type.

## Rent a GPU

Lambda's launch takes **exactly one SSH key**, so at least one must be named; the library gives it the first of \`sshKeyIds\` and adds any others at the first boot. The instance's login is \`ubuntu\` (reported as \`server.ssh.username\`, so you never hard-code it, and [\`RemoteMachine\`](#/ssh) logs in as it):

\`\`\`ts run title="A GPU instance, restarted and deleted"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");

// what is in stock right now, cheapest first, each with the regions that have one
const offers = await lambda.listOffers({ minVramGb: 24, maxPricePerHour: 2 });
for (const o of offers.slice(0, 3)) console.log(\`\${o.gpuCount}x \${o.gpu} (\${o.vramGb} GB): $\${o.pricePerHour}/h in \${o.regions.join(", ")}\`);

const server = await lambda.createServer({ name: "worker-1", offer: offers[0], sshKeyIds: [key.id] });
const running = await lambda.waitUntilRunning(server.id);
console.log(running.status, running.ip, "log in as", running.ssh?.username);

await lambda.restartServer(server.id); // returns once the instance reads as active
console.log("cost so far:", (await lambda.getServerCost(server.id))?.usd);
await lambda.deleteServerAndWait(server.id);
await lambda.deleteSSHKey(key.id);
\`\`\`

## What the type will not let you do

There is no stop on Lambda, so \`LambdaCloud\` has no \`stopServer\`. The editor tells you before you run anything (this block is meant to fail, and the page shows why):

\`\`\`ts error title="Lambda has no stop"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
await lambda.stopServer("instance-id");
\`\`\`

Options are typed the same way. A Lambda instance is a VM, so it runs no container of its own: the top-level \`env\` that RunPod and Vast take is refused. And a filesystem grows as it fills, so asking for a size is an error too:

\`\`\`ts error title="A VM takes no top-level env"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers();
await lambda.createServer({ name: "w", offer, sshKeyIds: ["k"], env: { MODEL: "llama" } });
\`\`\`

\`\`\`ts error title="A Lambda filesystem has no size"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
await lambda.createVolume({ name: "models", region: "us-east-1", sizeGb: 50 });
\`\`\`

Fix them and the red lines go. Code written for *any* provider (\`AnyProvider\`, \`ICompute\`) is offered every option, and each provider still refuses what it cannot honor at run time (\`NotSupportedError\`, before anything is rented). More in [Types and completion](#/types).

## A filesystem many instances share

A Lambda filesystem is **shared** (any number of instances of its region mount it) and **elastic** (no size), and is mounted **at launch only**, at a path under \`/home\`, \`/lambda/nfs\` or \`/data\`:

\`\`\`ts run title="A filesystem for model weights"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await lambda.listOffers();
const region = offer.regions[0];

const weights = await lambda.createVolume({ name: "weights", region }); // no sizeGb: it grows as it fills
console.log(weights.shared, weights.sizeGb, weights.mountPath); // true undefined /lambda/nfs/weights

const server = await lambda.createServer({
  name: "trainer", offer, region, sshKeyIds: [key.id],
  mounts: [{ volume: weights, path: "/lambda/nfs/weights" }],
});
await lambda.waitUntilRunning(server.id);
console.log(server.mounts);

await lambda.deleteServerAndWait(server.id); // waits until the filesystem is let go of
await lambda.deleteVolume(weights.id);
await lambda.deleteSSHKey(key.id);
\`\`\`

## A container, by cloud-init

\`container\` runs your image with Docker, from a script cloud-init runs at the first boot. On a machine with an NVIDIA GPU its GPUs are passed through (\`--gpus all\`) and the NVIDIA container toolkit is installed where the image lacks it. The image runs as the container \`asap-vps\`, so \`docker logs asap-vps\` reads it:

\`\`\`ts run title="Docker from the first boot"
import { LambdaCloud } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await lambda.listOffers();

const server = await lambda.createServer({
  name: "inference", offer, sshKeyIds: [key.id],
  container: {
    image: "ghcr.io/acme/worker:1",
    env: { MODEL: "llama-3-8b" },
    command: ["serve", "--port", "8000"],
    ports: ["8000/tcp"],
    registryAuth: { username: "bot", password: process.env.GHCR_PULL_TOKEN ?? "a-token-that-can-only-pull" },
  },
});
const running = await lambda.waitUntilRunning(server.id);
console.log(running.status, "- docker logs asap-vps, over SSH, reads the container");

await lambda.deleteServerAndWait(server.id);
await lambda.deleteSSHKey(key.id);
\`\`\`

The registry login rides in the instance's user data, which the account and the server can read: give a token that can only pull. [Containers on any provider](#/containers) compares all five.

## Class hierarchy

\`LambdaCloud\` is a \`BaseProvider\`. Below is what that gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

\`\`\`heritage
lambda
\`\`\`
`;var Ke=`# RunPod

\`RunPod\` rents **pods**: containers on GPU (and CPU) hosts. A pod is the container, so you give it an \`image\`, not an OS: there is no boot script, but there are \`command\`, \`env\`, \`ports\` and a private-registry login. A stopped pod bills only its volume.

## A GPU pod

\`listOffers\` takes the same query on every provider. \`minCudaVersion\` matters most on container platforms: the pod runs your image on the host's driver, so only hosts whose driver runs at least that CUDA are offered. An image asked for by the library's names (\`{ os, cuda }\`) is placed by its CUDA version without being told; with an image of your own, pass \`minCudaVersion\` to \`createServer\` too.

\`\`\`ts run title="Rent a GPU, read its logs, stop it, start it"
import { CUDA_TYPES, MACHINE_TYPES, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const cuda = CUDA_TYPES.CUDA_12_8;

// what can be rented right now, cheapest first, on hosts whose driver runs the image's CUDA
const [offer] = await runpod.listOffers({ minVramGb: 24, maxPricePerHour: 1, minCudaVersion: cuda });
console.log(\`\${offer.gpuCount}x \${offer.gpu}, \${offer.vramGb} GB, $\${offer.pricePerHour}/h in \${offer.regions.join(", ")}\`);

// the offer brings its region, GPU count and (interruptible) bid: nothing to repeat
const server = await runpod.createServer({
  name: "my-gpu",
  offer,
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda }, // NVIDIA's CUDA 12.8 image; the pod is placed on a host whose driver runs it
  command: ["sh", "-c", 'nvidia-smi -L; echo "hello from $MODEL"; sleep infinity'],
  env: { MODEL: "llama-3-8b" },
});
await runpod.waitUntilRunning(server.id);
console.log(await runpod.getServerLogs(server.id)); // the container's own output

await runpod.stopServer(server.id); // returns once it is stopped: a stopped pod bills only its volume
console.log("cost while stopped:", await runpod.getServerCost(server.id)); // null
await runpod.startServer(server.id); // returns once it runs again
await runpod.deleteServerAndWait(server.id);
\`\`\`

\`stopServer\`, \`startServer\` and \`restartServer\` wait on every provider that has them, and take \`{ timeoutMs?, intervalMs? }\` to say for how long. A pod rented by an offer goes to the offer's first data center with stock; where that one cannot place it (no host there runs the CUDA your image needs), the offer's next is tried. Pass \`region\` to pin it. A stopped pod can resume without its GPU (the host gave it to someone else): \`startServer\` then stops it again and throws \`CapacityError\`, so a retry loop knows to move on. See [Errors](#/errors).

A pod is **logged in to like any server**: name the keys with \`sshKeyIds\` and the library starts an SSH server in the container ahead of its command, with exactly those keys, at the endpoint the running pod reports as \`server.ssh\`. An image of your own needs a \`command\` for it to hand over to. RunPod reads a pod as running some seconds before its ports are published, so \`waitUntilRunning\` returns it only once each port it exposes has its public one, and its SSH endpoint with them. See [Logging in and setting up](#/ssh).

Pods also come **without a GPU**: \`listOffers({ kind: "cpu" })\` returns CPU flavors, and the rest of the call is the same.

## A network volume, mounted at a path

A RunPod volume is **shared** (any pod in its data center mounts it), has a fixed size (10 to 4096 GB) and is mounted at the path you give (default \`/workspace\`). A pod mounts one network volume, and is placed in the volume's data center:

\`\`\`ts run title="Weights that outlive the pods that use them"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const [offer] = await runpod.listOffers({ minVramGb: 24 });
const region = offer.regions[0];

const models = await runpod.createVolume({ name: "models", region, sizeGb: 100 }); // bills until deleteVolume
console.log(models.name, models.sizeGb, "GB in", models.region, "| shared:", models.shared);

const pod = await runpod.createServer({
  name: "worker", offer, region, image: "nvidia/cuda:12.8.1-base-ubuntu24.04", command: ["sleep", "infinity"],
  mounts: [{ volume: models, path: "/models" }],
});
console.log((await runpod.waitUntilRunning(pod.id)).mounts); // [{ volumeId, path: '/models' }]

await runpod.deleteServerAndWait(pod.id); // later, any number of pods in \`region\` mount the same weights
await runpod.deleteVolume(models.id);
\`\`\`

## A private image

\`registryAuth\` is the login for the registry the image comes from. RunPod stores it on the account once (named \`asap-vps:<user>@<host>:<hash>\`, with no secret in the name) and every pod with the same login reuses it:

\`\`\`ts run title="Pull from a private registry"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const [offer] = await runpod.listOffers({ minVramGb: 16 });

const pod = await runpod.createServer({
  name: "private-worker",
  offer,
  image: "ghcr.io/acme/worker:1",
  registryAuth: { username: "bot", password: process.env.GHCR_PULL_TOKEN ?? "a-token-that-can-only-pull" }, // give a token that can only pull
});
console.log((await runpod.waitUntilRunning(pod.id)).status);
await runpod.deleteServerAndWait(pod.id);
\`\`\`

## Serverless endpoints

RunPod runs an image on demand behind an HTTPS URL, from zero workers (nothing billed while idle) to a cap. The image serves plain HTTP on its port, given to it as \`PORT\`: no platform SDK in it. These are RunPod's **load-balancing** endpoints, on a GPU or a CPU flavor:

\`\`\`ts run title="An endpoint from zero workers"
import { RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);

const [cpu] = await runpod.listEndpointOffers({ kind: "cpu" }); // priced per hour while a worker runs
const e = await runpod.createEndpoint({
  name: "whoami", container: { image: "traefik/whoami" }, port: 80, offer: cpu, minWorkers: 0, maxWorkers: 2,
});
console.log(e.url, e.status);

const r = await runpod.requestEndpoint(e, "/api"); // the account's key added, a cold start waited out
console.log(r.status, await r.json());

await runpod.deleteEndpoint(e.id); // its workers stop with it
\`\`\`

A note from the live API: an idle endpoint kept its worker for fifteen minutes after its last request, despite an \`idleTimeoutSeconds\` of 5. \`deleteEndpoint\` (which scales to no worker first) is what stops it. The [serverless guide](#/serverless) compares RunPod and Scaleway.

## Class hierarchy

\`RunPod\` is a \`BaseProvider\`. Below is what that gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

\`\`\`heritage
runpod
\`\`\`
`;var ze=`# Vast.ai

\`VastAI\` rents containers on a **marketplace**: every offer is one machine, listed by its host, so renting it twice answers "no longer available" and the offers change in seconds. A machine's place is where it is, a volume lives on one machine, and an image is a snapshot pushed to a registry of yours.

## Rent a machine

\`listOffers\` searches Vast for you (its API returns at most 64 offers a page, so the library pages by price). Each offer is one machine, and says where it is:

\`\`\`ts run title="Rent the cheapest machine that runs your CUDA"
import { CUDA_TYPES, MACHINE_TYPES, VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
const cuda = CUDA_TYPES.CUDA_12_8;

const offers = await vast.listOffers({ minVramGb: 16, minCudaVersion: cuda, maxPricePerHour: 1 });
const [offer] = offers;
console.log(\`\${offer.gpuCount}x \${offer.gpu}, \${offer.vramGb} GB, $\${offer.pricePerHour}/h\`);
console.log("regions:", offer.regions); // its location, and the machine itself: machine:<id>

const server = await vast.createServer({
  name: "trainer",
  offer,
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda }, // NVIDIA's CUDA 12.8 image: the machine's driver is checked for it first
  command: ["sh", "-c", 'nvidia-smi -L; echo "PORT is $PORT"; sleep infinity'],
  env: { PORT: "8080" },
  ports: ["8080/tcp"], // mapped to a random public port
});
const running = await vast.waitUntilRunning(server.id);
console.log(running.status, running.ports); // { privatePort: 8080, publicPort: <random>, ip, protocol }
console.log(await vast.getServerLogs(running.id));

await vast.stopServer(server.id); // returns once it is stopped: a stopped instance bills only its disk
await vast.deleteServerAndWait(server.id);
\`\`\`

\`includeInterruptible: true\` adds the **interruptible** offers (a bid price instead of the on-demand one: the offer's id carries the bid). \`minCudaVersion\`, or the CUDA version of an image asked for as \`{ os, cuda }\`, is checked against the machine's driver before anything is rented.

An instance is **logged in to like any server**: name the keys with \`sshKeyIds\` and the library starts an SSH server in the container ahead of its command (and of a \`userData\` script), with exactly those keys, and maps its port: the running instance reports where as \`server.ssh\`. An image of your own needs a \`command\` for it to hand over to. See [Logging in and setting up](#/ssh).

## One machine, one place

A Vast offer is one machine, so a \`region\` you ask for must be one of the offer's (its location, or its \`machine:<id>\`). Anything else is refused before anything is rented:

\`\`\`ts run title="A region that is not the offer's is refused"
import { VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
const [offer] = await vast.listOffers();

try {
  await vast.createServer({ name: "x", offer, region: "Mars", image: "ubuntu:24.04" });
} catch (e) {
  console.log((e as Error).message);
}
console.log("servers rented:", (await vast.listServers()).filter((s) => s.name === "x").length);
\`\`\`

## Volumes live on one machine

A Vast volume is storage on **one machine**: its region *is* the machine (\`machine:<id>\`, which an offer's \`regions\` names too), and only an instance rented on that machine mounts it, one at a time, at a path you give (default \`/data\`). \`offersOn(region)\` finds the offers on the volume's machine, so you can rent where it is later:

\`\`\`ts run title="A volume, and a second instance on the same machine"
import { VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
const [offer] = await vast.listOffers({ kind: "gpu" });
const machine = offer.regions.find((r) => r.startsWith("machine:"))!;

const data = await vast.createVolume({ name: "weights_v1", region: machine, sizeGb: 50 }); // letters, digits and underscores only
console.log(data.name, data.sizeGb, "GB on", data.region, "| mounts at", data.mountPath);

const base = { image: "nvidia/cuda:12.8.1-base-ubuntu24.04", command: ["sleep", "infinity"] };
const a = await vast.createServer({ name: "a", offer, ...base, mounts: [{ volume: data, path: "/models" }] });
console.log((await vast.waitUntilRunning(a.id)).mounts); // [{ volumeId, path: '/models' }]
await vast.deleteServerAndWait(a.id); // its volume is free again some 30 s later

const [again] = await vast.offersOn(machine); // [] while someone else rents that machine
const b = await vast.createServer({ name: "b", offer: again, ...base, mounts: [{ volume: data.id }] });
console.log((await vast.waitUntilRunning(b.id)).mounts); // default path: /data
await vast.deleteServerAndWait(b.id);
await vast.deleteVolume(data.id);
\`\`\`

## Images: snapshots in a registry of yours

Vast keeps no images. Its snapshot commits an instance's container and pushes it to a registry, so a \`VastAI\` given \`snapshots\` (a repository and a login that can push to it) has images: the repository's tags. The image boots on **any** machine, pulled with the snapshot login.

In the sandbox the registry is \`registry.fake\`; in your code it is \`ghcr.io\`, Docker Hub, or a Scaleway registry. Vast pushes under a tag of its own (\`instance_<id>_at_<time>\`), takes a minute, reports no progress, and works on a running or a stopped instance: \`createImage\` waits until the tag is there, then names the image:

\`\`\`ts run title="Snapshot an instance, boot the image on another machine"
import { VastAI } from "asap-vps";

const vast = new VastAI({
  apiKey: process.env.VAST_API_KEY!,
  snapshots: { server: "registry.fake", repository: "acme/snapshots", username: "pusher", password: "push-secret" }, // ghcr.io, in real code
});
const [first, second] = await vast.listOffers({ kind: "gpu" });

const a = await vast.createServer({ name: "golden", offer: first, image: "ubuntu:24.04", command: ["sleep", "infinity"] });
await vast.waitUntilRunning(a.id);

const image = await vast.createImage(a.id, { name: "trained-v1" }); // registry.fake/acme/snapshots:trained-v1
console.log(image.id, image.status, "boots anywhere:", image.regions.length === 0);
console.log((await vast.listImages()).map((i) => i.name)); // each image once, under its name

const b = await vast.createServer({ name: "from-image", offer: second, image: image.id, command: ["sleep", "infinity"] });
console.log((await vast.waitUntilRunning(b.id)).status); // pulled with the snapshot login

await vast.deleteServerAndWait(b.id);
await vast.deleteServerAndWait(a.id);
await vast.deleteImage(image.id); // every tag of it
\`\`\`

\`deleteImage\` deletes through the registry's API where it deletes (Docker Hub and ghcr.io do not, and say so), and through Scaleway's own API for a Scaleway registry.

## Class hierarchy

\`VastAI\` is a \`BaseProvider\`. Below is what that gives it, generated from the source when the site is built: the chain of classes, the capability interfaces it implements, and which of their methods are written once for every provider and which this class writes itself.

\`\`\`heritage
vast
\`\`\`
`;var Ve='# Types and completion\n\nWhat a provider can do is a set of **capabilities**, each an interface (`ICompute`, `IPower`, `IImages`, `IVolumes`, ...). A class implements exactly the capabilities its platform has, so you can read what it can do from its type, and the editor offers only that. Every block on this page is a live editor: that is the point.\n\n## Try it\n\nClick into the editor, put the cursor on a new line after `digitalOcean.` and press `Ctrl+Space`. Then do the same after `lambda.` and compare the two lists. Hover over any name for its documentation; press `Ctrl+Shift+Space` inside a call for its parameters.\n\n```ts\nimport { DigitalOcean, LambdaCloud, RunPod, VastAI } from "asap-vps";\n\ndeclare const key: string;\nconst digitalOcean = new DigitalOcean(key);\nconst lambda = new LambdaCloud(key);\nconst runpod = new RunPod(key);\nconst vast = new VastAI(key);\n\n// Type `digitalOcean.` here, then `lambda.`, then `runpod.` and compare what each offers:\n\n```\n\nWhat you will find: `digitalOcean.stopServer` exists, and `lambda.stopServer` does not (Lambda cannot stop an instance); `runpod.getServerLogs` and `vast.getServerLogs` exist, because containers have logs and VMs do not; `digitalOcean.copyImage` exists and `vast.copyImage` does not.\n\n## The compiler says it before you run it\n\n```ts error title="Lambda has no stop"\nimport { LambdaCloud } from "asap-vps";\n\nconst lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);\nawait lambda.stopServer("instance-id");\n```\n\nOptions are typed the same way. Each provider\'s `createServer` options leave out what its platform cannot honor, so the editor offers only what it takes. `providerOptions` are the fields of the platform\'s own create request, typed by it (`DigitalOceanCreateDropletParams` on DigitalOcean) and open to fields its type does not list yet:\n\n```ts error title="providerOptions are the platform\'s own fields, typed"\nimport { DigitalOcean } from "asap-vps";\n\nconst digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);\nconst [offer] = await digitalOcean.listOffers({ kind: "cpu" });\nawait digitalOcean.createServer({\n  name: "web-1", offer, region: offer.regions[0],\n  providerOptions: { backups: "yes" }, // DigitalOcean\'s `backups` is a boolean\n});\n```\n\n`createVolume` asks for a size only where the platform sizes volumes (a RunPod volume is 10 to 4096 GB, a Lambda filesystem grows as it fills), and a platform that makes one kind of volume takes no `shared`:\n\n```ts error title="RunPod makes one kind of volume"\nimport { RunPod } from "asap-vps";\n\nconst runpod = new RunPod(process.env.RUNPOD_API_KEY!);\nawait runpod.createVolume({ name: "models", region: "US-TX-3", sizeGb: 50, shared: false });\n```\n\nRecords are typed per platform too. `raw` is what the platform itself returned, with no cast:\n\n```ts run title="raw is the platform\'s own record"\nimport { DigitalOcean } from "asap-vps";\n\nconst digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);\nconst [offer] = await digitalOcean.listOffers({ kind: "cpu" });\nconst created = await digitalOcean.createServer({ name: "web-1", offer, region: offer.regions[0] });\nconst server = await digitalOcean.waitUntilRunning(created.id);\n\n// server.raw is a DigitalOceanDropletData: hover it, and complete `server.raw.`\nconsole.log(server.raw.size_slug, server.raw.region?.slug, server.raw.status);\nawait digitalOcean.deleteServerAndWait(server.id);\n```\n\n## Code that takes any provider asks first\n\nA union of providers (`AnyProvider`) offers only what all of them have. To use more, ask: `supports` narrows the type to the providers that have the capability, and `requireCapability` returns the capability or throws a `NotSupportedError` naming what is missing.\n\n```ts run title="supports narrows the type"\nimport { providersFromEnv, supports } from "asap-vps";\n\nfor (const provider of providersFromEnv(process.env)) {\n  if (supports(provider, "power")) {\n    // inside here `provider` has IPower: stopServer exists, and the capability says what a stop bills\n    console.log(provider.id.padEnd(12), "can stop; stopped, it bills", provider.capabilities.power.stoppedBilling);\n  } else {\n    console.log(provider.id.padEnd(12), "cannot stop");\n  }\n}\n```\n\n```ts error title="Without asking, a provider may not have it"\nimport { providersFromEnv } from "asap-vps";\n\nfor (const provider of providersFromEnv(process.env)) {\n  await provider.stopServer("id");\n}\n```\n\n```ts run title="requireCapability throws with a reason"\nimport { createProvider, NotSupportedError, requireCapability } from "asap-vps";\n\nconst lambda = createProvider("lambda", process.env.LAMBDA_API_KEY!); // typed: a LambdaCloud, not a union\ntry {\n  await requireCapability(lambda, "images").listImages();\n} catch (e) {\n  console.log(e instanceof NotSupportedError, "-", (e as Error).message);\n}\n```\n\n`createProvider("lambda", key)` is typed by its id: it is a `LambdaCloud`, with no `stopServer`. Its settings are typed by the id too: `createProvider("scaleway", { apiKey, projectId })` takes Scaleway\'s Project, and Lambda\'s does not. `providersWith("images", "imageCopy")` answers from the capability descriptors, without building anything:\n\n```ts run title="Which providers have what, from the descriptors"\nimport { providersWith } from "asap-vps";\n\nconsole.log("can copy images:", providersWith("images", "imageCopy"));\nconsole.log("have volumes and images:", providersWith("volumes", "images"));\nconsole.log("run serverless endpoints:", providersWith("serverless"));\n```\n\nThe [capability table](#/overview) on the overview page is generated from the same descriptors, every time the site is built.\n';var Ge=`# Containers, on any provider

\`container\` runs one image the same way everywhere: \`{ image, env?, command?, ports?, registryAuth? }\`. What differs is how the platform runs it, and the library hides that:

- **RunPod and Vast** run the image as the server itself. \`container\` is the same as the top-level \`image\`, \`env\`, \`command\`, \`ports\` and \`registryAuth\` (one or the other: both are refused).
- **DigitalOcean, Scaleway and Lambda** are VMs. They run it with Docker, from a script cloud-init runs once at the first boot.

\`\`\`ts run title="One container, five providers"
import { DigitalOcean, LambdaCloud, RunPod, Scaleway, VastAI } from "asap-vps";

const container = {
  image: "ghcr.io/acme/worker:1",
  env: { MODEL: "llama-3-8b" },
  command: ["serve", "--port", "8000"],
  ports: ["8000/tcp"],
  registryAuth: { username: "bot", password: "a-token-that-can-only-pull" }, // never your own password
};

// Containers: the pod or instance is the container.
const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const pod = await runpod.createServer({ name: "worker", offer: (await runpod.listOffers())[0], container });

const vast = new VastAI(process.env.VAST_API_KEY!);
const instance = await vast.createServer({ name: "worker", offer: (await vast.listOffers())[0], container });

// VMs: Docker runs it from the first boot.
const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [doOffer] = await digitalOcean.listOffers({ kind: "cpu" });
const droplet = await digitalOcean.createServer({ name: "worker", offer: doOffer, region: doOffer.regions[0], container });

const scaleway = new Scaleway({ apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID! });
const [scwOffer] = await scaleway.listOffers({ kind: "cpu" });
const scwServer = await scaleway.createServer({ name: "worker", offer: scwOffer, region: scwOffer.regions[0], container });

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const key = await lambda.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const vm = await lambda.createServer({ name: "worker", offer: (await lambda.listOffers())[0], sshKeyIds: [key.id], container });

for (const [name, p, s] of [["runpod", runpod, pod], ["vast", vast, instance], ["digitalocean", digitalOcean, droplet], ["scaleway", scaleway, scwServer], ["lambda", lambda, vm]] as const) {
  console.log(name.padEnd(13), (await p.waitUntilRunning(s.id)).status);
  await p.deleteServerAndWait(s.id);
}
await lambda.deleteSSHKey(key.id);
\`\`\`

## What a VM runs

For the three VMs the library writes the script. Docker is installed where the image has none, the image is pulled (logged in with \`registryAuth\`, the password on stdin, and logged out again), and it runs as the container \`asap-vps\`, so \`docker logs asap-vps\` reads it. It restarts with the machine (\`--restart unless-stopped\`), its ports are published on the host's, and its environment is in a root-only file. On a machine with an NVIDIA GPU its GPUs are passed through (\`--gpus all\`), and the NVIDIA container toolkit is installed where the image lacks it. See exactly what it is:

\`\`\`ts run title="The boot script a VM gets"
import { containerBootScript } from "asap-vps";

const script = containerBootScript({
  image: "ghcr.io/acme/worker:1",
  env: { MODEL: "llama-3-8b" },
  command: ["serve", "--port", "8000"],
  ports: ["8000/tcp"],
}, { gpu: true });
console.log(script.split("\\n").filter((l) => /docker (run|login|pull)|--gpus|--restart/.test(l)).join("\\n"));
\`\`\`

Your own \`userData\` still runs first: both go to cloud-init as one multipart document. An env name a shell cannot take, a value with a line break, or a port Docker cannot publish is refused before anything is rented.

> The registry login rides in the server's user data, which the account and the server can read: give a token that can only pull.

Where a platform cannot take part of the spec, the compiler says so: a VM's top-level \`env\` is a type error, since its container is \`container\`. See [Types and completion](#/types).
`;var Ne=`# Images

A server set up once can be captured as an image, so the next one boots with everything already installed. Three of the five can capture one, and each does it the way its platform allows:

| Provider | An image is | Boots | Copy to other regions | Import a disk file |
|---|---|---|---|---|
| [DigitalOcean](#/digitalocean) | a snapshot | in its region (and the regions it was copied to) | \`copyImage\` | from a URL: raw, qcow2, vhdx, vdi, vmdk; up to 100 GB |
| [Scaleway](#/scaleway) | a snapshot, in a zone | in its zone (and the zones it was copied to) | \`copyImage\`, through Object Storage | a QCOW2, up to 1 TB, through Object Storage |
| [Vast.ai](#/vast) | a snapshot pushed to **a registry of yours** | on any machine | not needed: a registry image pulls anywhere | not needed |
| [Lambda](#/lambda) | none: Lambda has no snapshot or image API | | | |
| [RunPod](#/runpod) | none: a pod is not committed; build the image in CI and push it | | | |

\`capabilities.images.scope\` says where an image boots: \`'region'\` (DigitalOcean, Scaleway) or \`'global'\` (Vast). \`listImages()\` returns every image of the account, not just yours: pick yours by name before booting or deleting one.

## Capture, copy, boot

The same three calls on DigitalOcean and on Scaleway; only the names of places differ:

\`\`\`ts run title="DigitalOcean and Scaleway, side by side"
import { DigitalOcean, Scaleway } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const scaleway = new Scaleway({
  apiKey: process.env.SCW_SECRET_KEY!, projectId: process.env.SCW_DEFAULT_PROJECT_ID!, accessKey: process.env.SCW_ACCESS_KEY,
});

const [doOffer] = await digitalOcean.listOffers({ kind: "cpu" });
const [scwOffer] = await scaleway.listOffers({ kind: "cpu" });

const droplet = await digitalOcean.waitUntilRunning((await digitalOcean.createServer({ name: "golden", offer: doOffer, region: doOffer.regions[0] })).id);
const instance = await scaleway.waitUntilRunning((await scaleway.createServer({ name: "golden", offer: scwOffer, region: scwOffer.regions[0] })).id);

await digitalOcean.stopServer(droplet.id); // stop first: a consistent disk
await scaleway.stopServer(instance.id);

const a = await digitalOcean.createImage(droplet.id, { name: "golden-v1" });
const b = await scaleway.createImage(instance.id, { name: "golden-v1" });
console.log("digitalocean:", a.regions, "| scaleway:", b.regions); // regions it boots in (zones, on Scaleway)

const a2 = await digitalOcean.copyImage(a.id, [doOffer.regions.find((r) => r !== doOffer.regions[0])!]);
const b2 = await scaleway.copyImage(b.id, [scwOffer.regions.find((z) => z !== scwOffer.regions[0]) ?? "fr-par-2"]);
console.log("copied:", a2.regions, b2.regions);

for (const [p, s, i] of [[digitalOcean, droplet, a], [scaleway, instance, b]] as const) {
  await p.deleteServerAndWait(s.id);
  await p.deleteImage(i.id); // Scaleway also deletes the snapshots, and the copies
}
\`\`\`

## Importing an image

An image built elsewhere (Packer, a distribution's cloud image) comes in with \`importImage\` on DigitalOcean and Scaleway, and is then one of the account's images like any other. The two handle the file differently: DigitalOcean fetches it itself, from a URL; Scaleway has it put in a bucket made for the occasion (streamed in parts when the file's server serves ranges, so this machine holds only the parts in flight), imported as a snapshot and imaged. Both are shown on their pages: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway).

## Vast: a registry is the image store

Vast pushes a snapshot to a registry you give it, and the registry's tags are the account's images. Because a registry image pulls on any machine, it boots anywhere. See [Vast.ai](#/vast) for the run, and \`deleteImage\` for how each registry deletes (Docker Hub and ghcr.io offer no delete through their APIs, and the error says where to delete).
`;var He='# Volumes\n\nStorage of your own that outlives the servers that mount it: where model weights and data stay between servers, instead of being baked into every image. A server mounts volumes when it is created and `deleteServer` leaves them. A volume bills until `deleteVolume`, mounted or not.\n\nA volume is in **one place** (a zone, a data center, a machine): a server elsewhere cannot mount it, and is refused before anything is rented. And it is one of two kinds, its `shared` says which: a **block device** one server holds at a time, or a **filesystem** many servers mount at once.\n\n| Provider | A volume is | Kind | Mounted at | Size |\n|---|---|---|---|---|\n| [DigitalOcean](#/digitalocean) | a Block Storage volume, ext4 | block: one droplet | DigitalOcean\'s own place, `/mnt/<name>` | fixed, 1 to 16384 GiB |\n| [DigitalOcean](#/digitalocean) | a Network File Storage share | shared: droplets of its VPC | a path of yours, over NFS | fixed, 50 to 32768 GB |\n| [Scaleway](#/scaleway) | a Block Storage volume | block: one server | a disk the server formats and mounts itself | fixed, from 1 GB |\n| [Scaleway](#/scaleway) | a File Storage filesystem (Paris) | shared: Instances of a type that attaches one | a path of yours, with virtiofs | fixed, 25 to 50000 GB |\n| [Lambda](#/lambda) | a filesystem | shared: instances of its region | a path of yours under `/home`, `/lambda/nfs` or `/data` | elastic: it grows as it fills |\n| [RunPod](#/runpod) | a network volume | shared: pods of its data center | a path of yours (default `/workspace`) | fixed, 10 to 4096 GB |\n| [Vast.ai](#/vast) | storage on one machine | block: one instance at a time | a path of yours (default `/data`) | fixed, from 1 GB |\n\nEvery provider says this in its `capabilities.volumes`, which is also what decides what `createVolume` asks for. Where a platform makes both kinds, `createVolume({ ..., shared: true })` picks the filesystem, and the return type follows:\n\n```ts run title="What each provider says about its volumes"\nimport { PROVIDERS } from "asap-vps";\n\nfor (const [id, provider] of Object.entries(PROVIDERS)) {\n  const volumes = provider.capabilities.volumes;\n  if (!volumes) { console.log(id.padEnd(13), "no volumes"); continue; }\n  for (const kind of ["block", "shared"] as const) {\n    const t = volumes[kind];\n    if (t) console.log(id.padEnd(13), kind.padEnd(7), `mount: ${t.mount}`.padEnd(14), `size: ${t.size}${t.minGb !== undefined ? `, from ${t.minGb} GB` : ""}${t.maxGb !== undefined ? ` to ${t.maxGb} GB` : ""}`);\n  }\n}\n```\n\n`mount` is how a server sees the volume: `\'path\'` (mounted at the mount\'s `path`), `\'auto\'` (the platform mounts it at its own path, the volume\'s `mountPath`) or `\'device\'` (a disk the server formats and mounts itself).\n\n## Attaching to a running server\n\nDigitalOcean and Scaleway also attach and detach volumes on a server that is already running (the `volumeAttach` capability: `attachVolume` and `detachVolume`). The others fix a server\'s volumes when it is created.\n\n## One at a time\n\nA block volume is held by one server at a time. A second server that asks for it is refused before it is rented, and on some providers (DigitalOcean, Vast) a deleted server releases its volumes a little later, which `deleteServerAndWait` waits for.\n\nWalk through the volume of each provider: [DigitalOcean](#/digitalocean), [Scaleway](#/scaleway), [Lambda](#/lambda), [RunPod](#/runpod) and [Vast.ai](#/vast).\n';var We=`# Serverless endpoints

An endpoint runs one image on demand behind an HTTPS URL, from zero workers (nothing billed while idle) to a cap. The image serves plain HTTP on its port (given to it as \`PORT\`): no platform SDK goes in it. Two providers have this, and one interface covers both:

| | RunPod | Scaleway |
|---|---|---|
| What it is | load-balancing endpoints (\`https://<id>.api.runpod.ai\`) | Serverless Containers, one namespace per endpoint |
| Workers | a GPU type of a serverless pool, or a CPU flavor (2 vCPU or more) | CPU only |
| A private image | \`registryAuth\`, stored once on the account | the Project's own registry, or a public image |
| Idle | a worker may stay for fifteen minutes | an instance stops after 15 minutes |
| Authentication | the account key, as a bearer token | the account key, as \`X-Auth-Token\` |

Vast's serverless needs its Python agent in the worker, and DigitalOcean and Lambda have none, so \`providersWith("serverless")\` is RunPod and Scaleway.

## The same calls on both

\`\`\`ts run title="An endpoint on every provider that has them"
import { providersFromEnv, supports } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  if (!supports(provider, "serverless")) continue; // narrows provider to those with IServerless

  const [offer] = await provider.listEndpointOffers({ kind: "cpu" });
  const endpoint = await provider.createEndpoint({
    // across providers an offer is passed by its id: the offer objects are typed per platform
    name: \`whoami-\${provider.id}\`, container: { image: "traefik/whoami" }, port: 80, offer: offer.id, minWorkers: 0, maxWorkers: 2,
  });
  const response = await provider.requestEndpoint(endpoint, "/api"); // the account's key added, a cold start waited out
  console.log(provider.id.padEnd(9), endpoint.url, "->", response.status, (await response.json()).method);

  await provider.deleteEndpoint(endpoint.id); // its workers stop with it
}
\`\`\`

\`requestEndpoint\` sends the account's key only to the platform's own host: RunPod's URL is made from the endpoint's id, and Scaleway's is read from the platform and held to \`*.scw.cloud\`. A redirect is **not followed**: its answer is returned, since \`fetch\` would otherwise send the key on to wherever it points. It waits out a cold start (no worker up yet, a fresh host name that does not resolve yet) up to \`timeoutMs\`, five minutes by default.

The provider pages show each in turn, with their own options: [RunPod](#/runpod) and [Scaleway](#/scaleway).
`;var Be=`# What a server costs

Every offer and server carries its rate, \`pricePerHour\` (USD for the whole machine), and \`billing\`: how its provider counts time, in steps of \`incrementSeconds\` (1 per second, 60 per minute, 3600 per hour), never less than \`minimumSeconds\`, and never less than \`minimumUsd\` where the provider has a minimum charge. A server also says when its current run began billing (\`billingStartedAt\`, read from the provider's own record), so its cost is the time since then, counted the provider's way.

| Provider | Counted | A run bills from | While stopped |
|---|---|---|---|
| DigitalOcean | per second, at least 60 s or $0.01 | its creation, until it is deleted | the run goes on: a stopped droplet bills in full |
| Scaleway | per minute with a GPU (RENDER-S per hour), per hour without | its last change of state (an edit moves it too) | \`null\`: only volumes and IPs bill |
| RunPod | per second | the pod's last start | \`null\`: only the volume bills |
| Vast.ai | per second | the rental's start, which a stop and start does not move: after one, the estimate is an upper bound | \`null\`: only the disk bills |
| Lambda Cloud | per minute | its first passed health check | (no stop) |

## The bill so far

\`\`\`ts run title="The cost of a run, counted the provider's way"
import { DigitalOcean } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
console.log("billing:", offer.billing); // { incrementSeconds: 1, minimumSeconds: 60, minimumUsd: 0.01 }

const created = await digitalOcean.createServer({ name: "batch-1", offer, region: offer.regions[0] });
const server = await digitalOcean.waitUntilRunning(created.id);
console.log("billing since", new Date(server.billingStartedAt!).toISOString());

// the run so far: { usd, pricePerHour, from, to, billedSeconds }
console.log(await digitalOcean.getServerCost(server.id));
// or up to a given time, when the server runs for hours
console.log(await digitalOcean.getServerCost(server.id, Date.now() + 3 * 3_600_000));

await digitalOcean.deleteServerAndWait(server.id);
console.log("after delete:", await digitalOcean.getServerCost(server.id)); // null: nothing bills
\`\`\`

(In the sandbox the clock runs ahead of itself while the library waits, so the run shows more than the real seconds it took.)

## Before renting

\`estimateCost\` counts any span at any rate the same way, so you can price a job on an offer before renting it. A 90-second job is billed 90 s on DigitalOcean and two minutes on Lambda:

\`\`\`ts run title="What a 90 second job costs on each provider's cheapest GPU"
import { estimateCost, providersFromEnv } from "asap-vps";

for (const provider of providersFromEnv(process.env)) {
  const [offer] = await provider.listOffers({ kind: "gpu" });
  if (!offer) continue;
  const job = estimateCost(offer.pricePerHour, 0, 90_000, offer.billing); // from 0 to 90 s
  console.log(provider.id.padEnd(13), \`$\${offer.pricePerHour.toFixed(2)}/h\`.padEnd(9), \`billed \${job.billedSeconds} s\`.padEnd(14), \`= $\${job.usd.toFixed(4)}\`);
}
\`\`\`

An estimate is the rate applied to the time: disks, bandwidth and addresses bill on top, and the provider's invoice is the truth.
`;var Me=`# Errors and retries

Failures are typed, all extending \`ProviderError\`, so code can tell "try another offer" from "your key is wrong" without reading messages:

| Error | Means | Usually |
|---|---|---|
| \`CapacityError\` | this offer or region has no stock right now | try another offer |
| \`QuotaError\` | an account limit or balance | raise it, or pay |
| \`AuthError\` | the key is wrong or may not do this | fix the key |
| \`NotFoundError\` | there is no such thing | check the id |
| \`NotSupportedError\` | the platform cannot do this | pick another provider |
| \`TransportError\` | no answer at all, or one cut off | retry (a read) or find the server by name (a create) |

## "Next offer" on a CapacityError

Marketplaces and GPU clouds sell out in seconds. The idiom is a loop over offers that moves on when one is gone:

\`\`\`ts run title="Rent the first offer that is still there"
import { CapacityError, VastAI } from "asap-vps";

const vast = new VastAI(process.env.VAST_API_KEY!);
// the listing says which machines are rented out right now, when asked
const offers = await vast.listOffers({ kind: "gpu", includeUnavailable: true });
const soldOut = offers.find((o) => o.regions.length === 0)!; // no stock anywhere
const candidates = [soldOut, ...offers.filter((o) => o.regions.length > 0)];

for (const offer of candidates) {
  try {
    const server = await vast.createServer({ name: "w", offer, image: "ubuntu:24.04", command: ["sleep", "infinity"] });
    console.log("rented", offer.id, "->", (await vast.waitUntilRunning(server.id)).status);
    await vast.deleteServerAndWait(server.id);
    break;
  } catch (e) {
    if (!(e instanceof CapacityError)) throw e; // only "no stock" moves on
    console.log("no stock for", offer.id, "-", e.message);
  }
}
\`\`\`

An offer object that has stock nowhere, given with no region, is a \`CapacityError\` on every provider, so this loop works unchanged on all five.

## A wrong key, and a missing capability

\`\`\`ts run title="AuthError and NotSupportedError"
import { AuthError, DigitalOcean, NotSupportedError, createProvider, requireCapability } from "asap-vps";

try {
  await new DigitalOcean("not-a-real-key").listServers();
} catch (e) {
  console.log(e instanceof AuthError, "-", (e as Error).message);
}

try {
  requireCapability(createProvider("runpod", process.env.RUNPOD_API_KEY!), "images");
} catch (e) {
  console.log(e instanceof NotSupportedError, "-", (e as Error).message);
}
\`\`\`

A create option a provider cannot honor is refused with \`NotSupportedError\` before anything is rented, never silently dropped.

## Retries

\`isRetriable(e)\` says whether a failure is safe to try again as it is: a read, or an idempotent request, that got no answer or a temporary error, or a refusal such as a rate limit. A **create is never retried** after a server error or a lost answer, because it may already have made a billed machine: find it by its name instead.

## What is left behind

A create that fails once it has made something deletes what it made. Where that delete fails too, the error has the code \`left_behind\` and names what is left: it bills until you delete it, and nothing else would find it. On Scaleway, deleting a server or an image reports what it left behind the same way: the volumes of a server, the snapshots of an image.
`;var Ye=`# Logging in and setting up

Every provider's servers are logged in to the same way, a VM or a container. Create the server with \`sshKeyIds\`, wait until it runs, and the server itself says where its sshd is, on which port, and whom to log in as:

\`\`\`ts run title="The same three facts, whatever rents the server"
import { CUDA_TYPES, LambdaCloud, MACHINE_TYPES, RunPod } from "asap-vps";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop";

// a VM: Lambda installs the key, and its login is ubuntu
const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const lambdaKey = await lambda.addSSHKey(publicKey, "laptop");
const vm = await lambda.createServer({ name: "vm-1", offer: (await lambda.listOffers())[0], sshKeyIds: [lambdaKey.id] });
console.log("lambda:", (await lambda.waitUntilRunning(vm.id)).ssh);

// a container: the library starts an SSH server in it, ahead of its command
const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const runpodKey = await runpod.addSSHKey(publicKey, "laptop");
const pod = await runpod.createServer({
  name: "pod-1",
  offer: (await runpod.listOffers())[0],
  image: { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 },
  sshKeyIds: [runpodKey.id],
});
console.log("runpod:", (await runpod.waitUntilRunning(pod.id)).ssh);

await lambda.deleteServerAndWait(vm.id);
await runpod.deleteServerAndWait(pod.id);
await lambda.deleteSSHKey(lambdaKey.id);
await runpod.deleteSSHKey(runpodKey.id);
\`\`\`

## Working on a machine

\`RemoteMachine.connect\` takes that server and the private key. This needs Node (sockets and key generation), so the blocks from here on are type-checked on every build but not run in the sandbox:

\`\`\`ts
import { CUDA_TYPES, MACHINE_TYPES, RemoteMachine, RunPod, SSHService } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const { publicKey, privateKey } = await SSHService.createKeys(); // in process: nothing is written to disk
const key = await runpod.addSSHKey(publicKey, "laptop");
const [offer] = await runpod.listOffers({ gpus: ["RTX 4090"] });
const server = await runpod.createServer({
  name: "worker-1", offer, image: { os: MACHINE_TYPES.UBUNTU_24, cuda: CUDA_TYPES.CUDA_12_8 }, sshKeyIds: [key.id],
});

const machine = await RemoteMachine.connect(await runpod.waitUntilRunning(server.id), { privateKey });
console.log((await machine.run("nvidia-smi -L")).stdout);   // as the login; an exit other than 0 throws RemoteCommandError
await machine.sudo("apt-get update");                        // as root: as it is for a root login, through sudo for any other
await machine.writeFile("/etc/app.env", "PORT=8080\\n", { mode: "600" });
console.log(await machine.readFile("/etc/app.env"));
await machine.close();
\`\`\`

The same lines work with a \`DigitalOcean\`, \`Scaleway\`, \`LambdaCloud\` or \`VastAI\` in place of the \`RunPod\`.

| Call | What it does |
|---|---|
| \`RemoteMachine.connect(server, { privateKey, username?, decryptionKey?, retry? })\` | A session to a running server, or to an \`{ host, port, username }\` given as it is. As the server's own login unless \`username\` names another. A server with no \`ssh\` endpoint (not running yet, or made with no key) says so. |
| \`run(command, { cwd?, env?, stdin?, check? })\` | The command as the login: \`{ stdout, stderr, code }\`. One that does not exit 0 throws \`RemoteCommandError\` (who ran what where, its status, all it wrote) unless \`check\` is false. |
| \`sudo(command, o?)\` | The command as root: as it is where the login is root, through passwordless \`sudo\` where it is not. |
| \`readFile(path, { sudo? })\`, \`writeFile(path, text, { mode?, owner?, sudo? })\` | A text file, as it is. The text goes over the session's input, never into a command line. |
| \`upload(local, remote)\`, \`download(remote, local)\` | A file over SFTP, as the login. |
| \`addUser(name, { publicKeys?, sudo?, shell? })\` | Makes a user, or brings one that exists to what is asked. |
| \`authorizeKeys(publicKeys, user?)\` | Adds keys to the ones that log in as \`user\` (default: the login itself), each once. |
| \`as(name, { privateKey })\` | A second session to the same machine, as another user. |
| \`root\`, \`ssh\` | The session with everything done as root (what a \`SetupPipeline\`'s steps run on), and the bare session (node-ssh's). |
| \`close()\` | Ends the session. |

## Not only root

\`addUser\` makes an ordinary user: a home, no password, the keys that log in as it, and with \`sudo: true\` the right to run anything as root with no password (\`sudo: false\` takes it back). It is the same call on a Debian, an Alpine or a RHEL family image, a VM or a container, and done again it changes nothing.

\`\`\`ts
import { DigitalOcean, RemoteMachine, SSHService } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const server = (await digitalOcean.getServer("123456"))!;
const rootKey = process.env.ROOT_PRIVATE_KEY!;

const machine = await RemoteMachine.connect(server, { privateKey: rootKey });
const deployKeys = await SSHService.createKeys();
await machine.addUser("deploy", { publicKeys: [deployKeys.publicKey], sudo: true });

const deploy = await machine.as("deploy", { privateKey: deployKeys.privateKey });
console.log((await deploy.run("whoami")).stdout); // deploy
await deploy.sudo("systemctl restart app");       // through its sudo
await deploy.close();
await machine.close();

// later, from anywhere: the user is the machine's, not the session's
const again = await RemoteMachine.connect(server, { privateKey: deployKeys.privateKey, username: "deploy" });
await again.close();
\`\`\`

To have the user from a VM's first boot, with no login at all, pass the same script as user data: \`userData: "#!/bin/sh\\n" + addUserScript("deploy", { publicKeys, sudo: true })\`. In a pipeline it is \`new AddUserStep("deploy", { publicKeys, sudo: true })\`.

## What differs underneath

How the keys get in differs by platform. What you call does not.

| Provider | Login | Where (\`server.ssh\`) | How \`sshKeyIds\` gets its keys in |
|---|---|---|---|
| DigitalOcean | \`root\` | the droplet's address, port 22 | DigitalOcean, at the create |
| Scaleway | \`root\` | the Instance's address, port 22 | Scaleway, at every boot: every key of the Project besides the ones named (\`capabilities.sshKeys.atCreate\` is \`'account'\`) |
| Lambda | \`ubuntu\`, which has sudo | the instance's address, port 22 | Lambda takes the first; the others are added at the first boot. At least one must be named |
| RunPod | \`root\` | the pod's public address and the port mapped to its 22 | an SSH server the library starts in the container, before its command |
| Vast | \`root\` | the machine's address and the port mapped to the container's 22 | the same SSH server, started the same way |

A container platform gives a container no SSH server, so \`sshKeyIds\` there starts one: OpenSSH, taking exactly the keys named and no password, with the container's own \`PATH\` and \`LD_LIBRARY_PATH\` in a session (so \`nvidia-smi\` and \`python\` are found as the image's own processes find them). It runs before the container's command and then hands over to it. Three things follow:

- **The container needs a command to hand over to.** An image named by the library (\`MACHINE_TYPES\`, \`{ os, cuda }\`) is given one that keeps it up. With an image of your own, pass \`command\`, as the whole command line (\`["python", "serve.py"]\`, not arguments to the image's entrypoint): the SSH server's start takes the entrypoint's place and then runs the command. Without one the create is refused before anything is rented.
- **The image must start as root**, and have either \`sshd\` or a package manager to install it with (apt-get, apk, dnf or yum; an install adds some seconds to the first boot). Where neither holds, the container does not start, and its log says why, rather than run where nobody can log in.
- **To use an image's own SSH setup instead**, leave \`sshKeyIds\` out and use the platform's way: on RunPod \`providerOptions: { startSsh: true }\` with \`env: { PUBLIC_KEY }\` and \`ports: ["22/tcp"]\`, in an image built for it; on Vast \`providerOptions: { runtype: "ssh" }\`.

\`\`\`ts run title="An image of your own needs a command to hand over to"
import { NotSupportedError, RunPod } from "asap-vps";

const runpod = new RunPod(process.env.RUNPOD_API_KEY!);
const key = await runpod.addSSHKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 laptop", "laptop");
const [offer] = await runpod.listOffers();
const pod = { name: "pod-1", offer, image: "ghcr.io/acme/model:latest", sshKeyIds: [key.id] };

try {
  await runpod.createServer(pod); // refused before anything is rented
} catch (e) {
  console.log(e instanceof NotSupportedError, (e as Error).message);
}

// say what the container runs, and it is rented with its SSH server ahead of that
const server = await runpod.createServer({ ...pod, command: ["python", "serve.py"] });
console.log((await runpod.waitUntilRunning(server.id)).ssh);
await runpod.deleteServerAndWait(server.id);
await runpod.deleteSSHKey(key.id);
\`\`\`

## Renting and setting up in one call

\`ServerProvisioner\` does the whole run on any provider with \`compute\` and \`sshKeys\`, a VM or a container. It makes a fresh key, rents the offer, waits for the server, runs a \`SetupPipeline\` over SSH (through sudo where the login is not root), and **deletes the server again if any of it fails**. A VPS, a GPU VM and a GPU container go through it the same way.

\`\`\`ts
import { AddUserStep, InstallDockerStep, LambdaCloud, RunCommandStep, ServerProvisioner } from "asap-vps";

const lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);
const [offer] = await lambda.listOffers({ gpus: ["A10"] });
const deployKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKd0 deploy@laptop";

const { server } = await new ServerProvisioner(lambda).provision({ serverOptions: { name: "worker-1", offer } }, (pipeline) => {
  pipeline
    .addStep(new InstallDockerStep())
    .addStep(new RunCommandStep(["nvidia-smi -L"], "check-gpu"))
    .addStep(new AddUserStep("deploy", { publicKeys: [deployKey], sudo: true }));
});
console.log(server.ip);
\`\`\`

The steps are small classes you can write your own of: \`InstallDockerStep\`, \`ConfigureFirewallStep\`, \`InstallSSLCertificateStep\`, \`CreateDirectoryStep\`, \`RunCommandStep\`, \`AddUserStep\`, \`AddAuthorizedKeyStep\` and \`InstallNodeStep\` ship with the library.

## Mounts and options go through

\`serverOptions\` is the same \`createServer\` options any provider takes, typed per platform:

\`\`\`ts
import { DigitalOcean, RunCommandStep, ServerProvisioner } from "asap-vps";

const digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);
const [offer] = await digitalOcean.listOffers({ kind: "cpu" });
const volume = await digitalOcean.createVolume({ name: "data", region: offer.regions[0], sizeGb: 20 });

const result = await new ServerProvisioner(digitalOcean).provision(
  { serverOptions: { name: "db-1", offer, region: offer.regions[0], mounts: [{ volume }] } },
  (pipeline) => void pipeline.addStep(new RunCommandStep([\`df -h \${volume.mountPath}\`], "volume")),
);
console.log(result.setupResults.map((r) => r.output));
\`\`\`

## A key a provider applies at every boot

Where the provider applies the account's keys at every boot (\`capabilities.sshKeys.appliedAtBoot\`: Scaleway), the provisioner keeps the key it registered and returns its id as \`providerSshKeyId\`. Deleting the key would lock the server out at its next boot, so delete it yourself once the server is gone.
`;var je='# Playground\n\nA blank file with the library\'s real types behind it, and the sandbox\'s fakes of all five providers behind `fetch`. Write anything, press **Run** (or `Ctrl+Enter`), and open the **Requests** tab to see the exact HTTP calls the library made. Press `Ctrl+Space` for completions.\n\n`process.env` holds a key every fake accepts: `DIGITAL_OCEAN_API_KEY`, `RUNPOD_API_KEY`, `VAST_API_KEY`, `LAMBDA_API_KEY`, and for Scaleway `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID` and `SCW_ACCESS_KEY`. Nothing here rents anything, and nothing leaves the page.\n\n```ts run title="Your code"\nimport { providersFromEnv } from "asap-vps";\n\n// Start here. Ideas:\n//   - rent something and look at `server.raw` (the platform\'s own record, typed)\n//   - make a volume, mount it, delete the server, and see that the volume is still there\n//   - ask a provider for something it cannot do, and read the error\n//   - delete a line and watch the Requests tab: the library\'s calls change with it\n\nfor (const provider of providersFromEnv(process.env)) {\n  const [offer] = await provider.listOffers();\n  console.log(provider.id.padEnd(13), offer ? `${offer.id} at $${offer.pricePerHour.toFixed(3)}/h` : "no offers");\n}\n```\n\n```ts run title="Every provider, constructed"\nimport { DigitalOcean, LambdaCloud, RunPod, Scaleway, VastAI } from "asap-vps";\n\nconst digitalOcean = new DigitalOcean(process.env.DIGITAL_OCEAN_API_KEY!);\nconst lambda = new LambdaCloud(process.env.LAMBDA_API_KEY!);\nconst runpod = new RunPod(process.env.RUNPOD_API_KEY!);\nconst vast = new VastAI(process.env.VAST_API_KEY!);\nconst scaleway = new Scaleway({\n  apiKey: process.env.SCW_SECRET_KEY!,\n  projectId: process.env.SCW_DEFAULT_PROJECT_ID!,\n  accessKey: process.env.SCW_ACCESS_KEY,\n});\n\n// Type `digitalOcean.`, `lambda.`, `runpod.`, `vast.` or `scaleway.` below and see what each offers.\nconsole.log(Object.keys(DigitalOcean.capabilities));\n```\n';var Fe="# How the sandbox works\n\nThe **Run** buttons here are a **simulation**. Nothing is rented, no key is sent anywhere, and nothing leaves the page. What runs is the library itself, in your browser, with the network and the clock swapped for stand-ins.\n\n## What is real\n\n- **The library.** Each run bundles asap-vps's actual code (the same `DigitalOcean`, `Scaleway`, `Lambda`, `RunPod` and `VastAI` classes, their retries, polling, mapping and error handling) and executes your snippet against it.\n- **The types.** The editors use the library's real `.d.ts` files, built from the source when the site is built. Completions, hover text and errors are what your own editor shows.\n- **The HTTP the library makes.** Each call goes through `fetch` with the real URL, method, headers and body. The **Requests** tab lists them.\n\n## What is simulated\n\n- **The provider.** `fetch` is replaced by a router: each provider's real host (`api.digitalocean.com`, `api.runpod.io`, `cloud.lambda.ai`, `console.vast.ai`, `api.scaleway.com` and their relatives) goes to an in-memory fake of that API, the same fakes the library's own offline tests use. They model what the live runs taught: DigitalOcean's key lag, Vast's offers going away, Scaleway's zones and quotas. They are not the providers, though. They know a small catalog and a few regions, and a fake can be wrong where a real API surprises.\n- **Time.** `setTimeout` takes a millisecond and moves a virtual clock forward by the time asked for, and `Date` follows it, so a ten-minute boot, a stop, a start and a billing hour pass in a moment. Costs are counted on the virtual clock.\n- **Node.** The library uses Node's `crypto`, `fs`, `os`, `util` and `stream`. In the browser those are small stand-ins: hashing, HMAC and random bytes work, files live in memory.\n- **Your environment.** `process.env` holds keys the fakes accept (`DIGITAL_OCEAN_API_KEY`, `RUNPOD_API_KEY`, `VAST_API_KEY`, `LAMBDA_API_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `SCW_ACCESS_KEY`). Your real keys are never needed and never read.\n\nEvery run starts a fresh worker, so the fakes start empty each time: a server you created in one run is not there in the next.\n\n## What it cannot do\n\nSome things need a real machine or a real disk, so those blocks are type-checked but have no **Run** button: logging in over SSH, generating key pairs, and Scaleway's `importImage` (it streams a disk file into a bucket). Anything that reaches a host that is not one of the fakes fails the way an unreachable host does:\n\n```ts run title=\"The sandbox reaches only its fakes\"\nexport {}; // a module, so await works at the top level\n\ntry {\n  await fetch(\"https://example.com/\");\n} catch (e) {\n  console.log(String(e));\n  console.log((e as { cause?: { message?: string } }).cause?.message);\n}\n```\n\nAnd the clock really does run ahead:\n\n```ts run title=\"A minute passes in no time\"\nexport {};\n\nconst started = Date.now();\nawait new Promise((resolve) => setTimeout(resolve, 60_000));\nconsole.log(`${Math.round((Date.now() - started) / 1000)} s passed on the clock`);\n```\n\n## How it is checked\n\nEvery block on the site is verified when the site is built (`npm run docs:check`): each is type-checked against the library's declarations, each **Run** block is executed in this same sandbox runner and must finish, and each block that claims a type error must really fail to compile. A headless browser then opens every page and repeats it, so what you read here is what ran.\n\nTo see what the library does against a real provider, use the [live tests](https://github.com/visgotti/asap-vps#running-tests) with your own key: they rent real machines and bill your account.\n";var P=[{slug:"overview",title:"Overview",group:"Start",summary:"One set of typed primitives for servers on any cloud.",md:Re},{slug:"quick-start",title:"Quick start",group:"Start",summary:"Install, keys, a first server.",md:$e},{slug:"digitalocean",title:"DigitalOcean",group:"Providers",summary:"Droplets: the widest set of capabilities.",md:De},{slug:"scaleway",title:"Scaleway",group:"Providers",summary:"Instances in zones, with File Storage and serverless containers.",md:Le},{slug:"lambda",title:"Lambda Cloud",group:"Providers",summary:"GPU VMs: no stop, shared filesystems.",md:Ue},{slug:"runpod",title:"RunPod",group:"Providers",summary:"GPU and CPU pods, network volumes, serverless endpoints.",md:Ke},{slug:"vast",title:"Vast.ai",group:"Providers",summary:"A GPU marketplace: one offer, one machine.",md:ze},{slug:"types",title:"Types and completion",group:"Guides",summary:"What the compiler knows.",md:Ve},{slug:"containers",title:"Containers",group:"Guides",summary:"One container spec on every provider.",md:Ge},{slug:"images",title:"Images",group:"Guides",summary:"Capture, copy, boot, import.",md:Ne},{slug:"volumes",title:"Volumes",group:"Guides",summary:"Block and shared storage that outlives servers.",md:He},{slug:"serverless",title:"Serverless",group:"Guides",summary:"Endpoints from zero workers.",md:We},{slug:"costs",title:"Costs",group:"Guides",summary:"Billing, counted each provider's way.",md:Be},{slug:"errors",title:"Errors and retries",group:"Guides",summary:"Typed failures.",md:Me},{slug:"ssh",title:"Logging in and setting up",group:"Guides",summary:"RemoteMachine, users, ServerProvisioner.",md:Ye},{slug:"sandbox",title:"How the sandbox works",group:"Sandbox",summary:"What is real, what is simulated.",md:Fe},{slug:"playground",title:"Playground",group:"Sandbox",summary:"A blank file with the fakes behind it.",md:je}],qe=a=>P.find(e=>e.slug===a);var H=a=>document.querySelector(a),u=a=>a.replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[e]),ka=a=>a.toLowerCase().replace(/<[^>]+>/g,"").replace(/&[a-z]+;/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),Ze=(()=>{try{return localStorage.getItem("asap-theme")}catch{return null}})(),$=Ze?Ze==="dark":matchMedia("(prefers-color-scheme: dark)").matches,Qe=()=>{document.documentElement.dataset.theme=$?"dark":"light",le?.then(a=>a.setTheme($))},le,Je=()=>(le??=import("./editor.js?v=mv8268vz"),le),Sa,Aa=()=>Sa??=fetch("capabilities.json?v=mv8268vz").then(a=>a.json()),xa=[["compute","Servers",a=>`${a.kind==="vm"?"VMs":"containers"}: ${[a.gpu&&"GPU",a.cpu&&"CPU"].filter(Boolean).join(" + ")}`],["power","Stop / start",a=>`stopped bills ${a.stoppedBilling==="full"?"in full":"storage only"}`],["restart","Restart",()=>"yes"],["logs","Container logs",()=>"yes"],["sshKeys","SSH keys",a=>a.appliedAtBoot?"applied at every boot":"yes"],["images","Images",a=>a.scope==="region"?"per region":"boot anywhere"],["imageCopy","Copy an image",()=>"yes"],["imageImport","Import a disk image",a=>`${a.formats.join(", ")}, up to ${a.maxGb} GB`],["volumes","Volumes",a=>[a.block&&`block (${a.block.mount})`,a.shared&&`shared (${a.shared.mount})`].filter(Boolean).join(" + ")],["volumeAttach","Attach to a running server",()=>"yes"],["serverless","Serverless",a=>[a.gpu&&"GPU",a.cpu&&"CPU"].filter(Boolean).join(" + ")]];async function Pa(a){let e=await Aa(),t=Object.keys(e);a.innerHTML=`<table class="caps-table"><thead><tr><th></th>${t.map(r=>`<th>${u(e[r].name)}</th>`).join("")}</tr></thead><tbody>${xa.map(([r,s,i])=>`<tr><th scope="row"><code>${r}</code> ${u(s)}</th>${t.map(o=>{let n=e[o].capabilities[r];return n===void 0?'<td class="no">\u2014</td>':`<td class="yes"><span class="tick">\u2713</span> ${u(i(n))}</td>`}).join("")}</tr>`).join("")}</tbody></table>`}var Ia,Ea=()=>Ia??=fetch("heritage.json?v=mv8268vz").then(a=>a.json());async function Oa(a,e){let t=(await Ea())[e];if(!t){a.textContent=`no inheritance data for "${e}"`;return}let r=t.chain.map((n,l)=>`<li class="her-node${l===0?" self":""}">
        <div class="her-head"><code class="her-name">${u(n.name)}${n.typeParams.length?u(`<${n.typeParams.map(c=>c.split(" ")[0]).join(", ")}>`):""}</code><span class="her-tag">${n.abstract?"abstract class":"class"}</span>${n.extends?`<span class="her-ext">extends <code>${u(n.extends)}</code></span>`:""}</div>
        ${n.implements.length?`<div class="her-impl">implements ${n.implements.map(c=>`<code>${u(c)}</code>`).join(" ")}</div>`:""}
        ${n.summary?`<p class="her-sum">${u(n.summary)}</p>`:""}
        <div class="her-file">${u(n.file)}</div></li>`).join(""),s=t.api.map(n=>`<code>${u(n.name)}</code>`).join(" extends "),i=t.capabilities.map(n=>`<tr><th scope="row"><code>${u(n.name)}</code></th><td><code>${u(n.interface)}</code></td><td class="her-methods">${n.methods.map(l=>{let c=l.own?`implemented by ${t.class}`:`implemented once, in ${l.from}, for every provider`;return`<code class="her-m${l.own?"":" inh"}" title="${u(c)}">${u(l.name)}</code>`}).join(" ")}</td></tr>`).join(""),o=t.inherited.map(n=>`<details class="her-inh"><summary><code>${u(n.name)}</code> gives ${u(t.class)} ${n.members.filter(l=>!l.protected).length} public members${n.members.some(l=>l.overridden)?`, of which ${u(t.class)} writes ${n.members.filter(l=>l.overridden).length} itself`:""}</summary><p>${n.members.map(l=>`<code class="her-m${l.overridden?" ovr":" inh"}" title="${u(`${l.abstract?"abstract, ":""}${l.protected?"protected ":""}${l.kind}${l.overridden?`, declared again in ${t.class}`:""}`)}">${u(l.name)}${l.abstract?" \u27C2":""}</code>`).join(" ")}</p></details>`).join("");a.innerHTML=`<div class="her-box">
        <div class="her-title">Class chain</div><ol class="her-chain">${r}</ol>
        <div class="her-title">API client</div><p class="her-api">${s}. <code>${u(t.class)}</code> holds one as <code>provider.api</code>: <code>provider.api.request('GET', '/path')</code> reaches any endpoint the capabilities do not cover.</p>
        <div class="her-title">Capability interfaces it implements</div>
        <div class="table-wrap"><table><thead><tr><th>Capability</th><th>Interface</th><th>Methods</th></tr></thead><tbody>${i}</tbody></table></div>
        <p class="her-legend"><code class="her-m">name</code> is written in <code>${u(t.class)}</code>; <code class="her-m inh">name</code> is written once in <code>BaseProvider</code> and shared by all providers.</p>
        <div class="her-title">What the base class gives it</div>${o}
        <p class="her-legend">\u27C2 marks an abstract member: each provider must write it.</p>
    </div>`}function _a(a){let e=Te(a.slug,a.md),t=[],r=0;return{html:new oe({renderer:{code({text:i}){let o=e[r++];return o?o.lang==="capabilities"?'<div class="caps" data-caps></div>':o.lang==="heritage"?`<div class="heritage" data-heritage="${u(o.code.trim())}"></div>`:`<div class="snippet" data-n="${r-1}"><pre class="plain"><code>${u(o.code)}</code></pre></div>`:`<pre><code>${u(i)}</code></pre>`},heading({tokens:i,depth:o}){let n=this.parser.parseInline(i),l=ka(n);(o===2||o===3)&&t.push({id:l,text:n.replace(/<[^>]+>/g,""),depth:o});let c=o===2||o===3?`<a class="anchor" href="#/${a.slug}/${l}" aria-label="Link to this section">#</a>`:"";return`<h${o} id="${l}">${c}${n}</h${o}>`},link({href:i,tokens:o}){let n=this.parser.parseInline(o);return/^https?:/.test(i)?`<a href="${u(i)}" target="_blank" rel="noopener">${n}</a>`:`<a href="${u(i)}">${n}</a>`},table(i){let o=i.header.map(l=>`<th>${this.parser.parseInline(l.tokens)}</th>`).join(""),n=i.rows.map(l=>`<tr>${l.map(c=>`<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");return`<div class="table-wrap"><table><thead><tr>${o}</tr></thead><tbody>${n}</tbody></table></div>`}}}).parse(a.md),fences:e,toc:t}}var F;async function Ca(a,e){let t=qe(a)??P[0];document.title=`${t.title} \xB7 asap-vps`;let{html:r,fences:s,toc:i}=_a(t),o=H("#article");o.innerHTML=`<header class="page-head"><div class="eyebrow">${u(t.group)}</div></header>${r}${Ra(t)}`,H("#toc").innerHTML=i.length?`<div class="toc-title">On this page</div>${i.map(n=>`<a class="d${n.depth}" href="#/${t.slug}/${n.id}">${u(n.text)}</a>`).join("")}`:"",document.querySelectorAll("#nav a").forEach(n=>n.classList.toggle("on",n.getAttribute("href")===`#/${t.slug}`)),document.body.classList.remove("nav-open"),o.querySelectorAll("[data-caps]").forEach(n=>{Pa(n)}),o.querySelectorAll("[data-heritage]").forEach(n=>{Oa(n,n.dataset.heritage)}),F?.disconnect(),F=new IntersectionObserver(n=>{for(let l of n){if(!l.isIntersecting)continue;let c=l.target;F.unobserve(c);let d=s[Number(c.dataset.n)],h=Ce(d);if(h==="static"){c.classList.add("static"),Ta(c,d);continue}Je().then(f=>f.mount(c,d,h,$)).catch(f=>console.error("the editor could not load",f))}},{rootMargin:"700px 0px"}),o.querySelectorAll(".snippet").forEach(n=>F.observe(n)),e?document.getElementById(e)?.scrollIntoView():window.scrollTo(0,0)}async function Ta(a,e){let t=e.attrs.title?`<div class="snippet-bar"><span class="snippet-title">${u(e.attrs.title)}</span></div>`:"";try{let r=await Je(),s=e.lang==="ts"?"typescript":e.lang==="bash"?"shell":e.lang;a.innerHTML=`${t}<pre class="static-code"><code>${await r.colorize(e.code,s)}</code></pre>`}catch{a.innerHTML=`${t}<pre class="static-code"><code>${u(e.code)}</code></pre>`}}function Ra(a){let e=P.indexOf(a),t=P[e-1],r=P[e+1];return`<nav class="pager">${t?`<a href="#/${t.slug}"><small>Previous</small>${u(t.title)}</a>`:"<span></span>"}${r?`<a class="next" href="#/${r.slug}"><small>Next</small>${u(r.title)}</a>`:"<span></span>"}</nav>`}function $a(){let a=[...new Set(P.map(e=>e.group))];H("#nav").innerHTML=a.map(e=>`<div class="nav-group">${u(e)}</div>${P.filter(t=>t.group===e).map(t=>`<a href="#/${t.slug}">${u(t.title)}</a>`).join("")}`).join("")}function Xe(){let[,a=P[0].slug,e]=location.hash.split("/");Ca(a,e)}$a();Qe();H("#theme").addEventListener("click",()=>{$=!$;try{localStorage.setItem("asap-theme",$?"dark":"light")}catch{}Qe()});H("#menu").addEventListener("click",()=>document.body.classList.toggle("nav-open"));addEventListener("hashchange",Xe);Xe();
