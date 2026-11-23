(function(){
'use strict';
const btn=document.getElementById('btnDocsPilot');
if(!btn)return;
const docs=[["Autoclave · Hoja de servicio", "AUTOCLAVE_HOJA_SERVICIO_APROBADA.pdf", "Visual aprobada"], ["Autoclave · Albarán", "AUTOCLAVE_ALBARAN_APROBADO.pdf", "Visual aprobada"], ["Autoclave · Factura", "AUTOCLAVE_FACTURA_APROBADA.pdf", "Visual conforme"], ["Mobiliario · Hoja de servicio", "MOBILIARIO_HOJA_SERVICIO_REFERENCIA.pdf", "Modelo de referencia"], ["Mobiliario · Albarán", "MOBILIARIO_ALBARAN_REFERENCIA.pdf", "Modelo de referencia"], ["Mobiliario · Factura", "MOBILIARIO_FACTURA_REFERENCIA.pdf", "Modelo de referencia"]];
btn.addEventListener('click',function(){
 document.querySelectorAll('.side-link').forEach(n=>n.classList.remove('active'));
 btn.classList.add('active');
 const app=document.getElementById('app');
 const title='<section class="hero"><div><h1>Modelos de documentos</h1><p>Consulta los modelos aprobados de hojas, albaranes y facturas.</p></div></section>';
 app.innerHTML=title+docs.map(([name,file,status])=>'<section class="panel" style="padding:16px;margin:12px 0"><h3>'+name+'</h3><p>'+status+'</p><a class="btn" target="_blank" rel="noopener" href="plantillas-aprobadas/'+file+'">Abrir PDF de referencia</a></section>').join('');
});
})();