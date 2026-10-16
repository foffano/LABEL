from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

root = Path(__file__).resolve().parents[1]
out = root / 'output/pdf/teste-label-100x150.pdf'
out.parent.mkdir(parents=True, exist_ok=True)
c = canvas.Canvas(str(out), pagesize=(100*mm,150*mm))
c.setTitle('Toffa - Teste LABEL 100 x 150 mm')
c.setLineWidth(.3*mm)
c.rect(5*mm,5*mm,90*mm,140*mm)
c.setFont('Helvetica-Bold',22)
c.drawCentredString(50*mm,130*mm,'TOFFA')
c.setFont('Helvetica-Bold',13)
c.drawCentredString(50*mm,119*mm,'TESTE DE IMPRESSAO')
c.setFont('Helvetica',12)
c.drawCentredString(50*mm,106*mm,'100 x 150 mm | LABEL')
c.setFont('Helvetica',9)
c.drawCentredString(50*mm,97*mm,'Tamanho real - uma etiqueta')
c.rect(40*mm,61*mm,20*mm,20*mm)
c.drawCentredString(50*mm,55*mm,'Quadrado: 20 x 20 mm')
c.line(25*mm,40*mm,75*mm,40*mm)
for x in range(25,76,5):
    c.line(x*mm,38*mm,x*mm,42*mm)
c.drawCentredString(50*mm,32*mm,'Esta linha deve medir 50 mm')
c.setFont('Helvetica',8)
c.drawCentredString(50*mm,19*mm,'Confira: texto nitido, sem cortes, sem girar.')
c.drawCentredString(50*mm,13*mm,'Borda a 5 mm das extremidades do PDF.')
c.showPage()
c.save()
print(out)
