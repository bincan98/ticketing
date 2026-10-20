const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = process.env.TICKET_TEST_PORT === undefined ? 4173 : Number(process.env.TICKET_TEST_PORT);
const requests = [];
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
const server = http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if (pathname === '/tests/lab-click' || pathname === '/tests/lab-telemetry') {
    let body=''; req.on('data',chunk=>{body+=chunk;if(body.length>100000)req.destroy();});
    req.on('end',()=>{requests.push({url:req.url,method:req.method,headers:req.headers,body});if(requests.length>500)requests.shift();res.writeHead(204);res.end();});return;
  }
  if (pathname === '/tests/lab-requests') {
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(requests));return;
  }
  if (pathname === '/tests/popup-preview.html') {
    const html=fs.readFileSync(path.join(root,'popup.html'),'utf8')
      .replace('href="popup.css"','href="/popup.css"')
      .replace('src="shared.js"','src="/shared.js"')
      .replace('src="analyze.js"','src="/analyze.js"')
      .replace('<script src="popup.js">','<script src="popup-preview.js"></script><script src="/popup.js">');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
  }
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'text/plain','Cache-Control':'no-store'});res.end(data);});
}).listen(port,'127.0.0.1',()=>console.log('DOM tests: http://127.0.0.1:'+server.address().port+'/tests/browser.html'));
module.exports = server;
