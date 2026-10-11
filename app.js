'use strict';
const $=id=>document.getElementById(id), $$=s=>[...document.querySelectorAll(s)];
const COLORS=['#FFD65A','#FF8068','#E994B4','#AE9CEE','#7CACED','#75CDA0','#FFFFFF','#000000'];
let w=64,h=32,pixels=[],display=[],color=COLORS[0],connected=false,sending=false,tool='pen',tab='templates',zoom=1,undoStack=[],redoStack=[],dirty=true,selected='lost',lastSent=null,brightness=80,pointer=null,lastPoint=null,keyboard={x:0,y:0},pendingConfirm=null,toastTimer,saveTimer,brightnessTimer,scannedDevices=[],brightnessPending=null,deviceBusy=false,connectionAttempt=0;
const deviceService=window.DianDianDevice.createService();
const isMock=deviceService.mode==='mock';
const setText=(id,value)=>{const element=$(id);if(element)element.textContent=value;};
const blank=()=>Array(w*h).fill('#000000');
const font={H:['10001','10001','10001','11111','10001','10001','10001'],E:['11111','10000','10000','11110','10000','10000','11111'],L:['10000','10000','10000','10000','10000','10000','11111'],P:['11110','10001','10001','11110','10000','10000','10000'],S:['01111','10000','10000','01110','00001','00001','11110'],O:['01110','10001','10001','10001','10001','10001','01110'],T:['11111','00100','00100','00100','00100','00100','00100'],Y:['10001','10001','01010','00100','00100','00100','00100'],'!':['1','1','1','1','1','0','1'],' ':['000','000','000','000','000','000','000']};
function put(x,y,c,target=pixels){if(x>=0&&x<w&&y>=0&&y<h)target[y*w+x]=c;}
function stamp(pattern,x,y,scale,c,target=pixels){pattern.forEach((row,j)=>[...row].forEach((v,i)=>{if(v==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)put(x+i*scale+dx,y+j*scale+dy,c,target);}));}
function word(text,y,c,scale=1,target=pixels){const width=[...text].reduce((n,k)=>n+(font[k]?.[0].length||3)+1,0)*scale-scale;let x=Math.floor((w-width)/2);[...text].forEach(k=>{const g=font[k]||font[' '];stamp(g,x,y,scale,c,target);x+=(g[0].length+1)*scale;});}
const heart=['01100110','11111111','11111111','11111111','01111110','00111100','00011000'];
function templatePixels(name){pixels=blank();const sc=Math.max(1,Math.min(Math.floor(w/30),Math.floor(h/12)));if(name==='lost'){word('HELP',Math.floor((h-7*sc)/2)-Math.min(2,Math.floor(h/10)),color,sc);const y=Math.min(h-2,Math.floor((h+7*sc)/2)+2);for(let x=Math.floor(w*.29);x<Math.floor(w*.71);x++)put(x,y,color);for(let n=0;n<4;n++){put(Math.floor(w*.71)-n,y-n,color);put(Math.floor(w*.71)-n,y+n,color);}}else if(name==='help'){word('SOS',Math.floor((h-7*sc)/2),color,sc);}else if(name==='thanks'){let s=Math.max(1,Math.min(Math.floor(w/10),Math.floor(h/10)));stamp(heart,Math.floor((w-8*s)/2),Math.floor((h-7*s)/2),s,color);}else{let s=Math.max(1,Math.min(Math.floor(w/12),Math.floor(h/12)));stamp(['001111100','010000010','100000001','101000101','100000001','101000101','100111001','010000010','001111100'],Math.floor((w-9*s)/2),Math.floor((h-9*s)/2),s,color);}selected=name;}
function drawMatrix(canvas,data,dots=true,cell=8,grid=false){canvas.width=w*cell;canvas.height=h*cell;const c=canvas.getContext('2d');c.fillStyle='#101828';c.fillRect(0,0,canvas.width,canvas.height);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let col=data[y*w+x]||'#000000';c.fillStyle=col==='#000000'?'#263244':col;if(dots){c.beginPath();c.arc(x*cell+cell/2,y*cell+cell/2,cell*.31,0,Math.PI*2);c.fill();}else c.fillRect(x*cell,y*cell,cell-(grid?1:0),cell-(grid?1:0));}}
function renderEditor(){
  drawMatrix($('editorCanvas'),pixels,false,8,$('showGrid').checked);
  resizeCanvas();
  $('draftBadge').textContent=dirty?'待发送':'已同步';
  $('draftBadge').classList.toggle('synced',!dirty);
  $('undo').disabled=sending||!undoStack.length;
  $('redo').disabled=sending||!redoStack.length;
  $$('.template').forEach(button=>{
    const active=button.dataset.template===selected;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',String(active));
  });
}
function resizeCanvas(){const viewport=$('canvasViewport');if(!viewport.clientWidth)return;const width=Math.max(1,viewport.clientWidth-14)*zoom;$('editorCanvas').style.width=width+'px';$('editorCanvas').style.height=width*h/w+'px';$('zoomLabel').textContent=zoom+'×';$('zoomOut').disabled=sending||zoom===1;$('zoomIn').disabled=sending||zoom===4;}
function renderDisplay(){
  drawMatrix($('deviceCanvas'),display,true);
  drawMatrix($('largeCanvas'),display,true);
  $('deviceCanvas').style.aspectRatio=w+'/'+h;
  document.querySelector('.led-shell').style.maxWidth=Math.min(320,140*w/h+24)+'px';
  $('deviceCanvas').style.filter=`brightness(${brightness/100})`;
  $('largeCanvas').style.filter=`brightness(${brightness/100})`;
  const time=lastSent?new Date(lastSent).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
  const mode=isMock?'模拟屏幕':'屏幕';
  $('displayStatus').textContent=lastSent?`${mode} · ${time} 已更新`:'屏幕待机 · 等待你的第一条消息';
  $('previewInfo').textContent=`${w} × ${h} px · ${lastSent?(isMock?'模拟显示':'设备显示')+' · '+time+' 更新':(isMock?'模拟显示':'设备显示')+' · 尚未发送'}`;
  $('lastSentInfo').textContent=lastSent?`最近更新 ${time} · ${w*h} 像素 · RGB888`:'还没有发送记录。';
}
function change(){dirty=true;selected=null;renderEditor();scheduleSave();}
function snapshot(){undoStack.push(pixels.slice());if(undoStack.length>30)undoStack.shift();redoStack=[];}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(save,200);}
function save(){try{localStorage.setItem('diandian-v1',JSON.stringify({w,h,pixels,display,color,dirty,selected,lastSent,brightness}));}catch{}}
function restore(){try{const v=JSON.parse(localStorage.getItem('diandian-v1'));if(!v||!Number.isInteger(v.w)||!Number.isInteger(v.h)||v.w<8||v.h<8||v.w>256||v.h>128)return false;if(![v.pixels,v.display].every(a=>Array.isArray(a)&&a.length===v.w*v.h&&a.every(c=>/^#[0-9a-f]{6}$/i.test(c))))return false;w=v.w;h=v.h;pixels=v.pixels;display=v.display;color=/^#[0-9a-f]{6}$/i.test(v.color)?v.color:COLORS[0];dirty=!!v.dirty;selected=v.selected;lastSent=Number.isFinite(v.lastSent)?v.lastSent:null;brightness=Number.isFinite(v.brightness)?Math.round(Math.max(10,Math.min(100,v.brightness))):80;return true;}catch{return false;}}
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2700);}
// Keep palette rendering independent of pixel data: selecting a color never recolors a drawing.
function updatePalette(c){
  color=c.toUpperCase();
  $$('.swatch').forEach(button=>{
    const active=button.dataset.color===color;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  document.querySelector('.custom-color').classList.toggle('active',!COLORS.includes(color));
  $('customColor').value=color;
  $('colorHex').textContent=color;
  scheduleSave();
}
function initPalette(){COLORS.forEach((c,i)=>{const b=document.createElement('button');b.className='swatch'+(c==='#FFFFFF'?' white':'');b.style.background=c;b.dataset.color=c;b.setAttribute('aria-label',['暖黄色','珊瑚色','粉红色','紫色','蓝色','薄荷绿','白色','黑色'][i]);b.onclick=()=>updatePalette(c);$('palette').appendChild(b);});const l=document.createElement('label');l.className='custom-color';l.title='自定义颜色';l.innerHTML='<input type="color" id="customColor" aria-label="自定义颜色">';$('palette').appendChild(l);$('customColor').oninput=e=>updatePalette(e.target.value);updatePalette(color);}
function setTab(next){
  tab=next;
  $$('.tab').forEach(button=>{
    const active=button.dataset.tab===next;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
    button.tabIndex=active?0:-1;
    button.setAttribute('aria-controls',next==='draw'&&active?'drawingTools':button.dataset.tab==='text'?'textTab':button.dataset.tab==='draw'?'drawingTools':'templatesTab');
  });
  $('templatesTab').hidden=next!=='templates';
  $('textTab').hidden=next!=='text';
  $('drawingTools').hidden=next!=='draw';
  $('canvasTip').textContent=next==='draw'?'拖动绘制 · 放大可精确点选':'一格一像素 · 原生分辨率';
}
function updateDimensions(){
  $$('.dimensions').forEach(element=>element.textContent=`${w} × ${h}`);
  $('screenWidth').value=w;
  $('screenHeight').value=h;
  setText('pixelCount',`${(w*h).toLocaleString('zh-CN')} 个像素`);
}
function updateConnection(){
  const state=deviceService.getState();
  connected=state.connected;
  sending=state.operation==='sending';
  deviceBusy=state.busy;
  const titles={scanning:'正在寻找设备',connecting:'正在连接设备',disconnecting:'正在断开连接'};
  $('connectionTitle').textContent=titles[state.operation]||(connected?`${state.device?.name?.replace(' · Demo','')||'橙子旅伴'} · 已连接`:'连接你的橙子旅伴');
  $('connectionSub').textContent=connected?(state.device?.description||deviceService.label):(isMock?'模拟蓝牙 · 无需真实设备':'选择设备，连接后发送画面');
  $('connectButton').innerHTML=connected?'断开':'连接 <svg><use href="#i-arrow"/></svg>';
  $('connectButton').disabled=deviceBusy;
  $('resolutionButton').disabled=sending||state.operation==='clearing';
  $('sendHint').textContent=connected?'准备好了，让你的表达被看见':'连接设备，即可点亮屏幕';
  const status={scanning:'搜索中',connecting:'连接中',sending:'传输中',clearing:'清除中',disconnecting:'断开中',brightness:'同步亮度'};
  setText('deviceStatus',status[state.operation]||(connected?'已连接':'未连接'));
  $('deviceStatus')?.classList.toggle('connected',connected);
  document.querySelector('.device-card')?.classList.toggle('connected',connected);
  setText('deviceModeLabel',isMock?'模拟设备':'已接入设备');
  $$('.editor-column button, .editor-column input, .editor-column select').forEach(element=>element.disabled=sending);
  $('sendButton').disabled=deviceBusy&&!sending;
  $('sendButton').setAttribute('aria-busy',String(sending));
  $('sendButton').querySelector('span').textContent=sending?`正在${isMock?'模拟':''}发送 · ${Math.round(state.progress||0)}% · 点击取消`:'确定并发送到屏幕';
  $('brightness').disabled=['sending','clearing','disconnecting'].includes(state.operation);
  $('turnOff').disabled=deviceBusy;
  renderEditor();
}
function removeExtraDevices(){
  $$('#connectDialog [data-extra-device]').forEach(button=>button.remove());
}
function renderDevices(devices){
  removeExtraDevices();
  const first=$('selectDevice');
  first.hidden=!devices.length;
  devices.forEach((device,index)=>{
    const button=index===0?first:first.cloneNode(true);
    if(index>0){button.removeAttribute('id');button.dataset.extraDevice='';first.parentNode.insertBefore(button,first.nextSibling);}
    button.hidden=false;
    button.disabled=false;
    button.querySelector('strong').textContent=device.name;
    button.onclick=()=>connectDevice(device);
  });
}
function reportDeviceError(error,fallback){
  if(error.name==='AbortError')return;
  toast(error.message||fallback);
}
async function openConnection(){
  if(deviceBusy)return;
  const attempt=++connectionAttempt;
  scannedDevices=[];
  removeExtraDevices();
  $('scanStatus').textContent=isMock?'正在寻找演示设备…':'正在寻找设备…';
  $('selectDevice').hidden=true;
  $('connectDialog').showModal();
  try{
    const devices=await deviceService.scan();
    if(attempt!==connectionAttempt||!$('connectDialog').open)return;
    scannedDevices=devices;
    $('scanStatus').textContent=devices.length?`发现 ${devices.length} 台${isMock?'演示':''}设备`:'未发现设备，请关闭后重试';
    renderDevices(devices);
  }catch(error){
    if(error.name!=='AbortError'&&$('connectDialog').open){$('scanStatus').textContent=error.message||'搜索失败，请关闭后重试';reportDeviceError(error,'搜索设备失败');}
  }
}
async function connectDevice(device){
  if(deviceBusy)return;
  $$('#connectDialog .device-choice').forEach(button=>button.disabled=true);
  $('scanStatus').textContent='正在连接设备…';
  try{
    await deviceService.connect(device);
    $('connectDialog').close();
    brightnessPending=brightness;
    queueBrightness();
    toast(isMock?'模拟连接成功，可以发送了':'连接成功，可以发送了');
  }catch(error){
    if(error.name!=='AbortError'&&$('connectDialog').open){$('scanStatus').textContent=error.message||'连接失败，请重试';renderDevices(scannedDevices);reportDeviceError(error,'连接设备失败');}
  }
}
function queueBrightness(){
  clearTimeout(brightnessTimer);
  if(brightnessPending===null||!connected)return;
  brightnessTimer=setTimeout(async()=>{
    if(deviceService.getState().busy)return;
    const value=brightnessPending;
    brightnessPending=null;
    try{await deviceService.setBrightness(value);}
    catch(error){reportDeviceError(error,'亮度同步失败，请重新调整');}
    if(brightnessPending!==null)queueBrightness();
  },180);
}
function confirmAction(title,copy,callback){$('confirmTitle').textContent=title;$('confirmCopy').textContent=copy;pendingConfirm=callback;$('confirmDialog').showModal();}
function applyText(){if(sending)return;const text=$('messageInput').value.trim();if(!text){toast('先写下你想说的话');return;}const size=Number($('fontSize').value),c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.font=`300 ${size}px sans-serif`;if(ctx.measureText(text).width>w-2||size>h-2){$('textHint').textContent='文字超出屏幕，请减少字数、调小字号或增大屏幕尺寸。';toast('文字超出屏幕，请调整字数或字号');return;}snapshot();ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(text,w/2,h/2);const rgba=ctx.getImageData(0,0,w,h).data;pixels=blank();for(let i=0;i<pixels.length;i++)if(rgba[i*4+3]>100)pixels[i]=color;$('textHint').textContent='已生成文字。可进入像素绘制微调，再确认发送。';change();toast('文字已放入画布');}
function point(e){const r=$('editorCanvas').getBoundingClientRect();return{x:Math.min(w-1,Math.max(0,Math.floor((e.clientX-r.left)/r.width*w))),y:Math.min(h-1,Math.max(0,Math.floor((e.clientY-r.top)/r.height*h)))};}
function brush(x,y){const n=Number($('brushSize').value);for(let j=0;j<n;j++)for(let i=0;i<n;i++)put(x+i-Math.floor(n/2),y+j-Math.floor(n/2),tool==='erase'?'#000000':color);}
function line(a,b){let x=a.x,y=a.y,dx=Math.abs(b.x-x),sx=x<b.x?1:-1,dy=-Math.abs(b.y-y),sy=y<b.y?1:-1,err=dx+dy;while(true){brush(x,y);if(x===b.x&&y===b.y)break;let e=2*err;if(e>=dy){err+=dy;x+=sx;}if(e<=dx){err+=dx;y+=sy;}}}
function fill(x,y){const from=pixels[y*w+x];if(from===color)return;const queue=[y*w+x];pixels[y*w+x]=color;while(queue.length){const n=queue.pop(),cx=n%w,cy=Math.floor(n/w);for(const k of [cx>0?n-1:-1,cx<w-1?n+1:-1,cy>0?n-w:-1,cy<h-1?n+w:-1])if(k>=0&&pixels[k]===from){pixels[k]=color;queue.push(k);}}}
function endStroke(e){if(pointer!==e.pointerId)return;pointer=null;lastPoint=null;scheduleSave();}
$('editorCanvas').addEventListener('pointerdown',e=>{if(sending||pointer!==null||e.button!==0)return;e.preventDefault();if(tab!=='draw')setTab('draw');snapshot();pointer=e.pointerId;$('editorCanvas').setPointerCapture(e.pointerId);lastPoint=point(e);if(tool==='fill')fill(lastPoint.x,lastPoint.y);else brush(lastPoint.x,lastPoint.y);change();});
$('editorCanvas').addEventListener('pointermove',e=>{if(sending||e.pointerId!==pointer||tool==='fill')return;const p=point(e);line(lastPoint,p);lastPoint=p;dirty=true;renderEditor();});
$('editorCanvas').addEventListener('pointerup',endStroke);$('editorCanvas').addEventListener('pointercancel',endStroke);$('editorCanvas').addEventListener('lostpointercapture',endStroke);
$('editorCanvas').addEventListener('keydown',e=>{if(sending)return;const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(moves[e.key]){e.preventDefault();const [x,y]=moves[e.key];keyboard.x=Math.min(w-1,Math.max(0,keyboard.x+x));keyboard.y=Math.min(h-1,Math.max(0,keyboard.y+y));$('canvasTip').textContent=`光标 ${keyboard.x+1}, ${keyboard.y+1} · 空格绘制`;renderEditor();const c=$('editorCanvas').getContext('2d');c.strokeStyle='#fff';c.lineWidth=2;c.strokeRect(keyboard.x*8+1,keyboard.y*8+1,6,6);}else if(e.key===' '){e.preventDefault();setTab('draw');snapshot();tool==='fill'?fill(keyboard.x,keyboard.y):brush(keyboard.x,keyboard.y);change();}});
$$('.tab').forEach(button=>{
  button.onclick=()=>setTab(button.dataset.tab);
  button.addEventListener('keydown',event=>{
    const tabs=$$('.tab');
    const index=tabs.indexOf(button);
    let next;
    if(event.key==='ArrowRight')next=(index+1)%tabs.length;
    if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;
    if(event.key==='Home')next=0;
    if(event.key==='End')next=tabs.length-1;
    if(next===undefined)return;
    event.preventDefault();
    setTab(tabs[next].dataset.tab);
    tabs[next].focus();
  });
});$$('.template').forEach(b=>b.onclick=()=>{if(sending)return;snapshot();const defaults={lost:'#FFD65A',help:'#FF8068',thanks:'#E994B4',hello:'#75CDA0'};updatePalette(defaults[b.dataset.template]);templatePixels(b.dataset.template);dirty=true;renderEditor();scheduleSave();});$$('[data-tool]').forEach(b=>b.onclick=()=>{tool=b.dataset.tool;$$('[data-tool]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-pressed',String(t===b));});});
$('undo').onclick=()=>{if(!undoStack.length||sending)return;redoStack.push(pixels.slice());pixels=undoStack.pop();change();};$('redo').onclick=()=>{if(!redoStack.length||sending)return;undoStack.push(pixels.slice());pixels=redoStack.pop();change();};$('clear').onclick=()=>{if(sending)return;confirmAction('清空画布？','屏幕上的已发送内容保持显示。画稿清空后可以撤销。',()=>{if(sending)return;snapshot();pixels=blank();change();});};
$('zoomIn').onclick=()=>{zoom=Math.min(4,zoom*2);resizeCanvas();};$('zoomOut').onclick=()=>{zoom=Math.max(1,zoom/2);resizeCanvas();};$('showGrid').onchange=renderEditor;
$('messageInput').oninput=()=>{$('textLength').textContent=[...$('messageInput').value].length+' / 24';};$('applyText').onclick=applyText;$('messageInput').onkeydown=e=>{if(e.key==='Enter')applyText();};
// 语音输入：浏览器原生识别（免 Key，与中枢「说话」同一机制），结果填入文字消息输入框。
(function(){const mic=$('voiceInput');if(!mic)return;const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){mic.disabled=true;mic.title='这个浏览器不支持原生语音识别（建议 Chrome / Edge）';return;}const hintDefault=$('textHint').textContent;let on=false,rec=null;const sync=()=>{$('textLength').textContent=[...$('messageInput').value].length+' / 24';};const setOn=v=>{on=v;mic.classList.toggle('on',v);mic.setAttribute('aria-pressed',String(v));$('textHint').textContent=v?'正在听…再点一次结束。':hintDefault;};
mic.onclick=()=>{if(on){try{rec.stop();}catch{ /* 已停止 */ }return;}rec=new SR();rec.lang='zh-CN';rec.interimResults=true;rec.continuous=false;const base=$('messageInput').value?$('messageInput').value.replace(/\s*$/,'')+' ':'';rec.onresult=e=>{let interim='',final='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)final+=t;else interim+=t;}$('messageInput').value=(base+final+interim).slice(0,24);sync();};rec.onerror=e=>{setOn(false);toast('语音识别出错：'+(e.error||'未知'));};rec.onend=()=>{setOn(false);$('messageInput').value=$('messageInput').value.trim().slice(0,24);sync();toast($('messageInput').value?'听写完成，点「生成文字」上屏':'没有听到内容');};try{rec.start();setOn(true);}catch{$('textHint').textContent=hintDefault;toast('无法启动语音识别');}};})();
$('connectButton').onclick=async()=>{
  if(deviceBusy)return;
  if(!connected){openConnection();return;}
  try{await deviceService.disconnect();toast(isMock?'已断开模拟连接':'已断开设备连接');}
  catch(error){reportDeviceError(error,'断开连接失败');}
};
$('selectDevice').onclick=()=>{if(scannedDevices[0])connectDevice(scannedDevices[0]);};
$('connectDialog').addEventListener('close',()=>{
  connectionAttempt++;
  const operation=deviceService.getState().operation;
  if(operation==='scanning'||operation==='connecting')deviceService.cancel();
});
$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
$('confirmAction').onclick=()=>{const action=pendingConfirm;pendingConfirm=null;$('confirmDialog').close();if(action)action();};
$('confirmDialog').addEventListener('close',()=>{pendingConfirm=null;});
$('resolutionButton').onclick=()=>{if(sending)return;updateDimensions();$('sizeError').textContent='';$('resolutionDialog').showModal();};$$('[data-size]').forEach(b=>b.onclick=()=>{const [x,y]=b.dataset.size.split(',');$('screenWidth').value=x;$('screenHeight').value=y;});$('applySize').onclick=()=>{if(sending||deviceService.getState().operation==='clearing')return;const nw=Number($('screenWidth').value),nh=Number($('screenHeight').value);if(!Number.isInteger(nw)||!Number.isInteger(nh)||nw<8||nh<8||nw>256||nh>128){$('sizeError').textContent='宽需为 8 到 256、高需为 8 到 128 之间的整数。';return;}if(nw===w&&nh===h){$('resolutionDialog').close();return;}w=nw;h=nh;pixels=blank();display=blank();lastSent=null;undoStack=[];redoStack=[];zoom=1;keyboard={x:0,y:0};updateDimensions();change();renderDisplay();$('resolutionDialog').close();toast(`画布已设为 ${w} × ${h} 像素`);};
$('expandButton').onclick=()=>{$('previewDialog').showModal();renderDisplay();};
$('sendButton').onclick=async()=>{
  if(sending){deviceService.cancel();return;}
  if(deviceBusy)return;
  if(!connected){openConnection();return;}
  if(pointer!==null){$('editorCanvas').releasePointerCapture(pointer);pointer=null;lastPoint=null;}
  const captured=pixels.slice(),width=w,height=h;
  try{
    const result=await deviceService.sendFrame({width,height,format:'RGB888',pixels:captured});
    display=captured;
    lastSent=Number.isFinite(result?.sentAt)?result.sentAt:Date.now();
    dirty=w!==width||h!==height||pixels.some((pixel,index)=>pixel!==captured[index]);
    renderEditor();renderDisplay();save();
    toast(isMock?'发送成功，模拟屏幕已更新':'发送成功，屏幕已更新');
  }catch(error){
    if(error.name==='AbortError')toast('发送已取消，屏幕预览保持原内容');
    else reportDeviceError(error,'发送失败，请重试');
  }
};
$('brightness').oninput=event=>{
  brightness=Number(event.target.value);
  $('brightnessValue').textContent=brightness+'%';
  renderDisplay();scheduleSave();
  brightnessPending=brightness;
  queueBrightness();
};
$('turnOff').onclick=()=>{
  if(deviceBusy)return;
  confirmAction('清除屏幕显示？',`只清除${isMock?'模拟':''}屏幕，画稿会保留，可再次发送。`,async()=>{
    if(deviceBusy)return;
    try{
      let result;
      if(connected)result=await deviceService.clearDisplay({width:w,height:h});
      else if(!isMock){toast('请先连接设备，再清除屏幕');return;}
      display=blank();lastSent=Number.isFinite(result?.sentAt)?result.sentAt:Date.now();dirty=true;
      renderDisplay();renderEditor();save();toast(isMock?'模拟屏幕已清空':'屏幕已清空');
    }catch(error){reportDeviceError(error,'清除屏幕失败，请重试');}
  });
};
$$('[data-nav]').forEach(b=>b.onclick=()=>{const name=b.dataset.nav;$$('[data-nav]').forEach(n=>{n.classList.toggle('active',n===b);if(n===b)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});setText('pageTitle',{create:'创作中心',hub:'LLM 中枢',screen:'我的屏幕',guide:'使用指南',settings:'设置'}[name]);$('createPanel').hidden=name!=='create';if($('hubPanel'))$('hubPanel').hidden=name!=='hub';$('screenPanel').hidden=name!=='screen';$('guidePanel').hidden=name!=='guide';if($('settingsPanel'))$('settingsPanel').hidden=name!=='settings';if(name==='create')requestAnimationFrame(resizeCanvas);if(name==='screen')$('screenPanel').scrollIntoView({behavior:'smooth',block:'center'});if(name==='guide')$('guidePanel').scrollIntoView({behavior:'smooth',block:'start'});if(name==='settings')$('settingsPanel').scrollIntoView({behavior:'smooth',block:'start'});});
document.querySelector('.brand').onclick=e=>{e.preventDefault();document.querySelector('[data-nav="create"]').click();window.scrollTo({top:0,behavior:'smooth'});};
if(!restore()){pixels=blank();display=blank();templatePixels('lost');}initPalette();setTab(tab);$$('[data-tool]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tool===tool)));document.querySelector('[data-nav="create"]').setAttribute('aria-current','page');updateDimensions();renderEditor();renderDisplay();
let previousConnected=false;
deviceService.subscribe(state=>{updateConnection();if(previousConnected&&!state.connected&&state.error)toast(state.error);previousConnected=state.connected;if(!state.busy&&brightnessPending!==null)queueBrightness();});$('brightness').value=brightness;$('brightnessValue').textContent=brightness+'%';new ResizeObserver(resizeCanvas).observe($('canvasViewport'));window.addEventListener('pagehide',()=>{save();clearTimeout(brightnessTimer);deviceService.cancel();});
// Public integration boundary; drafts and canvas rendering remain inside this app.
window.DianDianApp=Object.freeze({device:deviceService,getFrame:()=>({width:w,height:h,format:'RGB888',pixels:pixels.slice()}),setArt:applyArt});
// voxway-gen：外部生成器写入画布的窄钩子（见 voxway-gen.js）。只接受合法像素数组，写入前可撤销。
function applyArt(frame,options){
  const {width:fw,height:fh,pixels:fp}=frame||{};
  if(!Number.isInteger(fw)||!Number.isInteger(fh)||fw<8||fw>256||fh<8||fh>128)throw new Error('画面宽高需要是宽 8–256、高 8–128 之间的整数');
  if(!Array.isArray(fp)||fp.length!==fw*fh)throw new Error(`画面像素数量应为 ${fw*fh}`);
  if(!fp.every(pixel=>typeof pixel==='string'&&/^#[0-9a-f]{6}$/i.test(pixel)))throw new Error('画面像素必须是六位十六进制颜色');
  if(sending)throw new Error('正在传输，稍后再试');
  snapshot();
  w=fw;h=fh;pixels=fp.slice();color=pixels.find(pixel=>pixel!=='#000000')||color;
  if(options?.toScreen!==false)display=pixels.slice();
  dirty=true;selected=null;
  updateDimensions();renderEditor();renderDisplay();save();
  return window.DianDianApp.getFrame();
}
window.__voxwayApplyArt=applyArt;
