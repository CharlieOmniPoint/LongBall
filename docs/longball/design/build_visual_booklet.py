from pathlib import Path
import math
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

ROOT=Path(__file__).parent
OUT=ROOT/'LongBall_Mobile_Design_Booklet_v0_1.pdf'
PAGE_W,PAGE_H=1190.55,841.89
W,H=390,844
FONT_DIR=Path('/usr/share/fonts/truetype/dejavu')
pdfmetrics.registerFont(TTFont('LB',str(FONT_DIR/'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('LB-Bold',str(FONT_DIR/'DejaVuSans-Bold.ttf')))
COLORS={
 'ink':'#14251D','muted':'#526459','green':'#126946','green_dark':'#0D4F35',
 'pitch':'#176B45','pitch_alt':'#1B754D','surface':'#F6F8F7','white':'#FFFFFF',
 'line':'#CAD5CE','mint':'#E6F2E9','amber':'#FFF2D4','amber_ink':'#7B4900',
 'red':'#A32622','red_bg':'#FFF0EF','disc':'#FFFFFF','gold':'#FFDB70',
 'blue':'#1C4B73','blue_bg':'#E9F1F8'
}
c=canvas.Canvas(str(OUT),pagesize=(PAGE_W,PAGE_H))
c.setTitle('LongBall Mobile Design Booklet v0.1')
c.setAuthor('LongBall product design')
c.setSubject('Proposed mobile screen designs using fictional examples')

def col(v):return HexColor(COLORS.get(v,v))
def rect(x,y,w,h,fill='white',radius=0,stroke=None,lw=1):
 c.setFillColor(col(fill));c.setLineWidth(lw)
 if stroke:c.setStrokeColor(col(stroke))
 if radius:c.roundRect(x,H-y-h,w,h,radius,fill=1,stroke=bool(stroke))
 else:c.rect(x,H-y-h,w,h,fill=1,stroke=bool(stroke))
def line(x1,y1,x2,y2,color='line',lw=1):
 c.setStrokeColor(col(color));c.setLineWidth(lw);c.line(x1,H-y1,x2,H-y2)
def text(x,y,s,size=16,color='ink',bold=False,align='left'):
 c.setFillColor(col(color));c.setFont('LB-Bold' if bold else 'LB',size)
 yy=H-y-size
 if align=='center':c.drawCentredString(x,yy,s)
 elif align=='right':c.drawRightString(x,yy,s)
 else:c.drawString(x,yy,s)
def para(x,y,s,width,size=15,color='ink',bold=False,leading=None):
 style=ParagraphStyle('p',fontName='LB-Bold' if bold else 'LB',fontSize=size,leading=leading or size*1.4,textColor=col(color))
 p=Paragraph(s,style);ww,hh=p.wrap(width,H);p.drawOn(c,x,H-y-hh);return hh
def pill(x,y,s,fill='mint',color='green',width=None):
 width=width or pdfmetrics.stringWidth(s,'LB-Bold',12)+24
 rect(x,y,width,27,fill,13)
 text(x+width/2,y+5,s,12,color,True,'center')
 return width
def button(x,y,w,s,fill='green',color='white',outline=False,h=48):
 rect(x,y,w,h,'white' if outline else fill,12,fill if outline else None,1.5)
 text(x+w/2,y+(h-18)/2-2,s,16,fill if outline else color,True,'center')
def chevron(x,y,color='muted',down=False):
 if down:line(x-4,y-2,x,y+2,color,1.7);line(x,y+2,x+4,y-2,color,1.7)
 else:line(x-3,y-5,x+2,y,color,1.7);line(x+2,y,x-3,y+5,color,1.7)
def circle(x,y,r,fill='green',stroke=None,lw=1):
 c.setFillColor(col(fill));c.setLineWidth(lw)
 if stroke:c.setStrokeColor(col(stroke))
 c.circle(x,H-y,r,fill=1,stroke=bool(stroke))
def badge(x,y,letters='RR',r=20):
 circle(x,y,r,'mint');text(x,y-10,letters,15,'green',True,'center')
def status(time='09:41'):
 text(22,9,time,12,'ink',True)
 for i in range(4):rect(319+i*4,21-(i+1)*2,2.5,(i+1)*2,'ink',1)
 c.setStrokeColor(col('ink'));c.setLineWidth(1.2);c.roundRect(347,H-22,22,10,2,stroke=1,fill=0)
 rect(349,14,16,6,'ink',1);rect(370,15,2,4,'ink',1)
def header(title,subtitle='Roma U10  •  26/27',back=False,role=None,time='09:41'):
 rect(0,0,W,113,'white');status(time)
 if back:
  line(26,61,19,68,'ink',2);line(19,68,26,75,'ink',2)
  text(43,51,title,21,'ink',True)
 else:
  text(20,44,title,25,'ink',True)
 if role:pill(287,46,role,width=83)
 text(20,85,subtitle,13,'muted')
 line(0,113,W,113)
def nav(active='Home',spectator=False,player_mode=False):
 rect(0,754,W,90,'white');line(0,754,W,754)
 labels=(['Scores','Results','Photos','Account'] if spectator else ['Home','Schedule','My game','Photos','More'] if player_mode else ['Home','Schedule','Team','Reports','More'])
 for i,s in enumerate(labels):
  x=(W/len(labels))*(i+.5)
  fill='mint' if s==active else 'white'
  ink='green' if s==active else 'muted'
  rect(x-28,763,56,29,fill,14)
  if s in ['Home','Scores']:
   line(x-8,781,x-8,773,ink,1.7);line(x-8,773,x,767,ink,1.7);line(x,767,x+8,773,ink,1.7);line(x+8,773,x+8,781,ink,1.7);line(x+8,781,x-8,781,ink,1.7)
  elif s in ['Schedule','Results']:
   c.setStrokeColor(col(ink));c.setLineWidth(1.7);c.roundRect(x-9,H-783,18,15,2,stroke=1,fill=0);line(x-9,773,x+9,773,ink,1.7)
  elif s=='Team':
   circle(x-4,772,4,ink);circle(x+5,775,3,ink);line(x-10,784,x+2,784,ink,4);line(x+3,784,x+10,784,ink,3)
  elif s in ['Reports','My game']:
   rect(x-10,775,4,9,ink,1);rect(x-2,769,4,15,ink,1);rect(x+6,765,4,19,ink,1)
  elif s=='Photos':
   c.setStrokeColor(col(ink));c.setLineWidth(1.5);c.roundRect(x-10,H-785,20,18,2,stroke=1,fill=0)
   circle(x+5,772,2,ink);line(x-8,782,x-2,775,ink,1.5);line(x-2,775,x+6,783,ink,1.5)
  elif s=='Account':
   circle(x,771,4,ink);line(x-8,783,x+8,783,ink,4)
  else:
   for xx in [x-7,x,x+7]:circle(xx,776,1.8,ink)
  text(x,797,s,10,ink,s==active,'center')
 rect(140,837,110,4,'ink',2)
def disc(x,y,initials,shirt,name=None,gk=False):
 circle(x,y+3,23,'green_dark')
 circle(x,y,23,'gold' if gk else 'disc', 'white',1.2)
 text(x,y-14,initials,16,'ink',True,'center')
 text(x,y+5,str(shirt),10,'ink',False,'center')
 if name:text(x,y+27,name,10,'white',False,'center')
def pitch(x,y,w,h,half=False,after=False):
 rect(x,y,w,h,'pitch',13)
 # Deliberately quiet stripes preserve label contrast.
 for i in range(6):
  if i%2:rect(x+9,y+10+i*(h-20)/6,w-18,(h-20)/6,'pitch_alt')
 c.setStrokeColor(HexColor('#FFFFFF'));c.setLineWidth(1)
 c.rect(x+12,H-y-h+12,w-24,h-24,stroke=1,fill=0)
 line(x+12,y+h/2,x+w-12,y+h/2,'#FFFFFF')
 c.circle(x+w/2,H-y-h/2,25,stroke=1,fill=0)
 c.rect(x+w*.30,H-y-12-31,w*.40,31,stroke=1,fill=0)
 c.rect(x+w*.30,H-y-h+12,w*.40,31,stroke=1,fill=0)
 # All hit areas in the implementation are >=48, independent of visible discs.
 positions=[(.50,.15,'OC',9,'OwenC'),(.22,.40,'LP' if after else 'NB',7 if after else 11,'LucaP' if after else 'NoahB'),(.78,.40,'EL',6,'EliL'),(.50,.56,'AM',8,'AriM'),(.28,.76,'JT',4,'JamieT'),(.72,.76,'FS',3,'FinnS'),(.50,.91,'TK',1,'TheoK')]
 # Compact pitch layouts omit secondary names, retaining initials and shirt numbers.
 for idx,(xx,yy,ini,shirt,name) in enumerate(positions):
  disc(x+w*xx,y+h*yy,ini,shirt,None,ini=='TK')
  text(x+w*xx-32,y+h*yy-7,['ST','LW','RW','CM','CB','CB','GK'][idx],9,'white',True,'right')
def bench(y,after=False):
 text(22,y,'BENCH',11,'muted',True)
 for x,ini,no,name in [(86,'NB' if after else 'LP',11 if after else 7,'NoahB' if after else 'LucaP'),(243,'MS',12,'MiloS')]:
  circle(x-35,y+48,20,'white','line')
  text(x-35,y+36,ini,13,'ink',True,'center');text(x-35,y+51,str(no),9,'muted',False,'center')
  text(x-6,y+36,name,14,'ink',True)
  text(x-6,y+56,'Available',11,'muted')
def score(y,score='2 : 1',stage='1st half',timer=None):
 badge(56,y+33);badge(334,y+33,'MF')
 text(195,y,score,35,'ink',True,'center')
 text(56,y+59,'Roma',14,'ink',True,'center');text(334,y+59,'Maple FC',14,'ink',True,'center')
 text(195,y+52,stage,12,'muted',False,'center')
 if timer:text(195,y+73,timer,32,'ink',True,'center')
def photo_art(x,y,w,h):
 rect(x,y,w,h,'#DCEBDD',10)
 rect(x,y+h*.55,w,h*.45,'#6A9C74',0)
 # Original vector placeholder, intentionally not a photograph or child depiction.
 c.setFillColor(col('white'));c.circle(x+w*.52,H-y-h*.60,h*.22,fill=1,stroke=0)
 pts=[]
 for i in range(5):
  a=math.radians(-90+i*72);pts.append((x+w*.52+math.cos(a)*h*.10,H-y-h*.60+math.sin(a)*h*.10))
 path=c.beginPath();path.moveTo(*pts[0])
 for p in pts[1:]:path.lineTo(*p)
 path.close();c.setFillColor(col('ink'));c.drawPath(path,fill=1,stroke=0)
 for dx,dy in [(w*.2,h*.2),(w*.75,h*.25),(w*.32,h*.38),(w*.82,h*.42)]:
  line(x+dx,y+dy,x+dx+8,y+dy+10,'gold',3)

def home():
 header('LongBall',role='Manager')
 text(20,133,'Your team, ready to play',22,'ink',True)
 text(20,166,'Richmond Rovers  /  Roma U10',14,'muted')
 rect(20,201,350,266,'white',16)
 pill(36,217,'NEXT GAME')
 text(36,259,'Roma vs Maple FC',23,'ink',True)
 text(36,294,'Sat 24 Oct  •  10:00  •  Home',14,'muted')
 line(36,330,354,330)
 for x,num,label in [(83,'9','Available'),(197,'2','Unsure'),(309,'2','No reply')]:
  text(x,346,num,25,'ink',True,'center');text(x,381,label,12,'muted',False,'center')
 button(36,409,318,'Prepare game')
 text(20,493,'Team tasks',18,'ink',True)
 for yy,title,sub,n in [(531,'Training attendance','Thu 22 Oct  •  18:00',None),(620,'Review game photos','2 uploads waiting for approval','2')]:
  rect(20,yy,350,74,'white',12)
  text(36,yy+12,title,16,'ink',True);text(36,yy+39,sub,13,'muted')
  chevron(348,yy+37)
 text(20,719,'13 squad players  •  Season 26/27',14,'muted')
 nav('Home')

def prematch():
 header('Match setup','Roma vs Maple FC  •  7-a-side',back=True,time='09:55')
 pill(20,129,'READY OFFLINE')
 text(20,171,'9 present  /  7 on pitch  /  2 bench',15,'ink',True)
 text(20,200,'Starting lineup',19,'ink',True)
 text(369,205,'2-3-1',13,'muted',False,'right')
 pitch(20,238,350,334)
 bench(588)
 rect(20,685,350,53,'mint',10)
 para(34,697,'Positions take effect when you start the first half.',320,14,'green')
 button(20,751,350,'Start first half  •  25:00',h=56)
 rect(140,837,110,4,'ink',2)

def live():
 header('Match live','You are controlling this game',back=True,time='10:16')
 pill(277,84,'SYNCED',width=94)
 score(126,timer='08:30 remaining')
 pitch(20,253,350,270)
 text(20,538,'Bench: LucaP 7  ·  MiloS 12',14,'muted')
 rect(20,571,350,83,'amber',12)
 text(35,582,'Next change 18:00  •  in 1:30',16,'amber_ink',True)
 text(35,610,'LucaP on  /  NoahB off',15,'ink')
 text(35,634,'Tap Substitute to review',12,'amber_ink')
 button(20,672,169,'Goal',h=56)
 button(201,672,169,'Substitute',h=56)
 button(20,740,169,'Unavailable','green','green',True,h=56)
 button(201,740,169,'End half','green','green',True,h=56)
 for xx in [343,350,357]:circle(xx,65,2,'ink')
 rect(140,837,110,4,'ink',2)

def substitute():
 header('Review substitution','1st half  •  clock continues running',back=True,time='10:16')
 pill(20,130,'NOT YET APPLIED','amber','amber_ink')
 text(20,177,'One change',25,'ink',True)
 text(20,212,'Normal position mode',14,'muted')
 for yy,name,info,tag,ini in [(257,'NoahB','Left wing  •  Shirt 11','OFF','NB'),(367,'LucaP','Left wing  •  Shirt 7','ON','LP')]:
  rect(20,yy,350,96,'white',14)
  circle(61,yy+47,25,'disc','line');text(61,yy+34,ini,17,'ink',True,'center')
  text(101,yy+16,name,20,'ink',True);text(101,yy+49,info,14,'muted')
  pill(305,yy+17,tag,'mint' if tag=='ON' else 'surface','green' if tag=='ON' else 'muted',50)
 text(20,491,'Why this change?',18,'ink',True)
 para(20,525,'Gives LucaP his next spell in a preferred position. The plan keeps both players on track for their fair-time targets.',350,16)
 rect(20,610,350,65,'mint',12)
 text(35,622,'Target: 37:30 each',17,'green',True)
 text(35,651,'Applied at the time you confirm.',12,'green')
 button(20,690,350,'Confirm now',h=56)
 button(20,758,350,'Keep current lineup','green','green',True)
 rect(140,837,110,4,'ink',2)

def halftime():
 header('Half-time','Roma vs Maple FC  •  first half complete',back=True,time='10:25')
 score(127,stage='Half-time  •  clock stopped')
 text(195,203,'First half played 25:00',12,'muted',False,'center')
 text(20,223,'Second-half lineup',19,'ink',True)
 pitch(20,260,350,307,after=True)
 bench(582,after=True)
 rect(20,678,350,61,'mint',12)
 text(35,690,'1 staged substitution',16,'green',True)
 text(35,716,'Changes apply together when you restart.',12,'green')
 button(20,751,350,'Start second half  •  25:00',h=56)
 rect(140,837,110,4,'ink',2)

def player():
 header('Your match','Roma U10  •  LucaP  •  Shirt 7',back=True,time='11:36')
 pill(20,129,'FULL TIME')
 text(20,171,'Roma 3 : 2 Maple FC',23,'ink',True)
 text(20,205,'Sat 24 Oct  •  Match report',14,'muted')
 rect(20,245,350,179,'white',16)
 text(36,261,'YOUR PLAYING TIME',12,'muted',True)
 text(36,289,'38:15',38,'ink',True)
 pill(200,300,'WITHIN TARGET',width=151)
 text(36,343,'Target 37:30  •  Range 33:45-41:15',13,'muted')
 line(36,375,354,375)
 text(36,389,'Left wing 23:15  /  Right wing 15:00',13,'ink')
 text(20,452,'Players’ player of the match',20,'ink',True)
 rect(20,492,350,196,'white',16)
 text(36,510,'Your vote is private',16,'ink',True)
 text(36,544,'Voting closes at 11:56',14,'muted')
 circle(59,596,20,'mint');text(59,585,'NB',13,'green',True,'center')
 text(91,575,'NoahB',18,'ink',True)
 text(91,603,'Your current choice',13,'muted')
 button(36,631,318,'Change your vote','green','green',True)
 text(20,714,'Your reports show your own minutes only.',12,'muted')
 nav('My game',player_mode=True)

def spectator():
 header('Scores','Roma U10  •  Spectator',back=False,time='10:18')
 score(130,stage='1st half  •  16:30 at last update')
 rect(20,239,350,71,'amber',12)
 text(35,252,'Waiting for the next update',16,'amber_ink',True)
 text(35,281,'Last synced 10:16  •  score may have changed',12,'amber_ink')
 text(20,337,'Goals',20,'ink',True)
 for y,tm,name,label in [(380,'12:40','OwenC','Roma  •  Open play'),(455,'09:03','Opposition goal','Maple FC'),(530,'06:12','NoahB','Roma  •  Open play')]:
  rect(20,y,350,66,'white',11)
  text(35,y+11,tm,16,'muted',True)
  text(111,y+8,name,16,'ink',True);text(111,y+35,label,12,'muted')
 text(20,623,'Published photos',18,'ink',True)
 photo_art(20,659,165,82);photo_art(201,659,169,82)
 nav('Scores',True)

def moderation():
 header('Review photo','Roma vs Maple FC  •  24 Oct 2026',back=True,time='11:17')
 pill(20,131,'PENDING REVIEW','amber','amber_ink')
 text(20,179,'Uploaded by LucaP',19,'ink',True)
 text(20,211,'Today at 11:09  •  1 of 2 pending',13,'muted')
 photo_art(20,249,350,238)
 text(20,507,'End-of-game celebration',18,'ink',True)
 para(20,534,'Only the uploader and authorised team managers can see this photo while it awaits review.',350,15,'muted')
 rect(20,608,350,78,'mint',12)
 text(35,620,'Publishing audience',16,'green',True)
 para(35,644,'Team players, managers and invited spectators with active access.',320,13,'green')
 button(20,696,350,'Approve and publish',h=56)
 button(20,760,350,'Decline photo','red','red',True)
 rect(140,837,110,4,'ink',2)

PAGES=[
 ('01','Manager home','UI04','Manager',home,
  'Prepare the next game and clear team tasks without entering the live match console.',
  [('Hierarchy','The next fixture is the first action. Availability counts remain distinct from actual attendance. Training and pending photo reviews sit below it.'),
   ('Interaction','Prepare game opens the fixture and match squad. Home, Schedule, Team, Reports and More remain stable outside live match mode.'),
   ('Role and state','The manager sees assigned-team tasks. Team and season context stay visible. No badge suggests that an availability reply proves attendance.'),
   ('Build checks','Support empty season, cancelled fixture, offline cache and session-expiry states. A manager without a current assignment must not see another team’s tasks.')]),
 ('02','Pre-match lineup','UI13','Manager controller',prematch,
  'Allocate seven starters and two available bench players before the first half begins.',
  [('Hierarchy','A clear readiness message precedes the pitch. Circular pieces show two-character initials and shirt numbers. The bench remains visually separate.'),
   ('Interaction','Drag a piece or tap a player and then a slot. Both routes stage the same change. Start first half validates and commits the lineup once.'),
   ('State and data','Ready offline means the fixture, squad and required settings are downloaded. Pre-match positions do not accrue player or bench minutes.'),
   ('Build checks','Reject duplicate allocations, an unavailable starter, wrong pitch capacity and uncovered goalkeeper. Each piece has a minimum 48 by 48 logical-pixel hit area.')]),
 ('03','Live match console','UI14','Manager controller',live,
  'Show the match state and next action while allowing the manager to keep watching football.',
  [('Hierarchy','Score and remaining half time lead. The pitch, bench summary and next-change card follow. Goal and Substitute are the primary actions.'),
   ('Interaction','At 16:30 active time the next proposed change at 18:00 is 90 seconds away. A warning suggests action. It never substitutes players automatically.'),
   ('State and data','The display shows only acknowledged or locally committed match events. Synced changes to Pending sync when offline. Other managers see a read-only console.'),
   ('Build checks','Test sunlight, wet-hand errors, text scaling and screen-reader order. Zero on the countdown alerts the manager. End half remains a deliberate manual action.')]),
 ('04','Confirm a substitution','UI16','Manager controller',substitute,
  'Make the proposed change explicit, then record the actual moment it is applied.',
  [('Hierarchy','The outgoing and incoming players are distinct. Position, shirt and reason are visible before confirmation. Normal position mode is identified.'),
   ('Interaction','Opening the review does not change the lineup or pause play. Confirm now applies the batch at one active-game timestamp. Keep current lineup returns without applying it.'),
   ('State and data','Targets are 37:30 for eight outfield players in a 50-minute, seven-a-side game with one fixed keeper and unchanged availability. No projection is presented as guaranteed.'),
   ('Build checks','Revalidate availability, controller authority, score mode and lineup revision at confirmation. Repeated taps and retried sync have one effect. Keep a visible correction route.')]),
 ('05','Half-time setup','UI18','Manager controller',halftime,
  'Allow a variable break and prepare the next lineup without adding playing time.',
  [('Hierarchy','Half-time score and clock-stopped text are explicit. The staged second-half lineup uses the same pitch interaction as pre-match.'),
   ('Interaction','The manager can move players during the break. Start second half commits all staged changes together and starts the planned 25-minute second half.'),
   ('State and data','The break has no fixed duration. Playing and available-bench intervals stay closed. First-half records remain intact and can be reviewed separately.'),
   ('Build checks','No substitution warning sounds during the break. Restart schedules fresh alerts. The second half retains its planned length even when the first half ended early or late.')]),
 ('06','Player report and vote','UI26 / UI22','Player or shared parent access',player,
  'Let a player see their own participation and cast one private teammate vote.',
  [('Hierarchy','Own minutes and own position coverage lead. The voting card is discreet. This screen never reveals another child’s named attendance, minutes or ballot.'),
   ('Interaction','The current choice can change before closure. The player cannot vote for themself. A parent using the same account shares this single ballot.'),
   ('State and data','The example ends at 10:57. Q15 proposes closing voting at 11:56, with the result due by 11:57. Final awards can show joint winners. Confirmed votes remain distinct from pending or failed submissions.'),
   ('Build checks','Do not infer that the child personally cast the vote. Preserve the original cutoff when full time synchronises late. Own position minutes must reconcile to 38:15 in this example.')]),
 ('07','Spectator match centre','UI21','Invited spectator',spectator,
  'Give invited supporters scores and scorers while making delayed information clear.',
  [('Hierarchy','The score leads. A prominent freshness message appears above goals whenever the controller has not synced. Goal times are match times, not wall-clock times.'),
   ('Interaction','Scores, season results and published photos are available for the invited team. A copied link cannot grant access. Q21 competition-sharing policy must permit this audience and content. There is no vote, upload or attendance route.'),
   ('State and data','The displayed 16:30 is the active match time at the last successful sync. The view must not keep advancing it as though the remote game were confirmed live.'),
   ('Build checks','Expired or revoked team-season access blocks all retrieval routes. Omit injuries, player-minute reports and private ballots. Thumbnail illustrations here stand in for approved photographs.')]),
 ('08','Approve a player photo','UI29','Assigned team manager',moderation,
  'Review a player upload and show the publication audience before publishing it.',
  [('Hierarchy','Pending review is unambiguous. Uploader, fixture and upload time provide context. The intended audience is stated immediately above the approval action.'),
   ('Interaction','Approve and publish makes this upload visible to authorised team viewers. Decline leaves it unpublished and follows the agreed retention and notification policy.'),
   ('State and data','The original vector artwork is a design stand-in, not a submitted photograph. Real uploads require safe processing, approval state and publication permission, including the applicable competition policy.'),
   ('Build checks','A player-uploaded image cannot appear in the shared gallery before approval. Managers can publish their own uploads deliberately without a second reviewer. Removal must revoke further image access.')])
]

def doc_text(x,y,s,size=14,color='ink',bold=False):
 c.setFillColor(col(color));c.setFont('LB-Bold' if bold else 'LB',size);c.drawString(x,PAGE_H-y-size,s)
def doc_para(x,y,s,width,size=15,color='muted',bold=False):
 p=Paragraph(s,ParagraphStyle('d',fontName='LB-Bold' if bold else 'LB',fontSize=size,leading=size*1.5,textColor=col(color)))
 ww,hh=p.wrap(width,PAGE_H);p.drawOn(c,x,PAGE_H-y-hh);return hh
def page(n,title,screenid,role,fn,purpose,notes):
 c.setFillColor(HexColor('#FFFFFF'));c.rect(0,0,PAGE_W,PAGE_H,fill=1,stroke=0)
 doc_text(50,30,'LongBall',20,'ink',True)
 doc_text(210,36,'MOBILE DESIGN SPECIFICATION',11,'muted',True)
 doc_text(50,72,f'{n}  {title}',28,'ink',True)
 # Phone frame. Device chrome is illustrative, not a target-device claim.
 px,py,scale=60,129,.77
 c.setFillColor(col('ink'));c.roundRect(px-7,PAGE_H-py-H*scale-7,W*scale+14,H*scale+14,23,fill=1,stroke=0)
 c.saveState();c.translate(px,PAGE_H-py-H*scale);c.scale(scale,scale)
 rect(0,0,W,H,'surface',20);fn();c.restoreState()
 rx,rw=414,704
 doc_text(rx,139,f'{screenid}  /  {role}',12,'green',True)
 yy=171
 yy+=doc_para(rx,yy,purpose,rw,21,'ink',True)+30
 for label,body in notes:
  doc_text(rx,yy,label,15,'ink',True);yy+=27
  yy+=doc_para(rx,yy,body,rw,15,'muted')+22
 doc_text(rx,731,'DESIGN STATUS',10,'muted',True)
 doc_para(rx,750,'Proposed visual design. Fictional fixture, players and values. Screen behaviour is specified in the mobile build pack. Shared player labels remain a proposed policy.',rw,11,'muted')
 doc_text(50,813,'Version 0.1  |  20 October 2026  |  Based on concept review v0.12',10,'muted')
 doc_text(1080,813,f'{int(n)} / 8',10,'muted')
 c.showPage()

for args in PAGES:page(*args)
c.save()
print(OUT)
