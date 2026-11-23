# Llibreta dia a dia — versió Firebase

Aquesta carpeta és la nova versió, del mateix estil que la pàgina del teu amic:

- **React + Vite** (interfície al navegador).
- **Firebase Authentication** (login amb correu i contrasenya).
- **Cloud Firestore** (usuaris i grups).
- **Firebase Hosting** (domini gratis `https://NOM-DEL-PROJECTE.web.app`).
- **Sense Firebase Storage**: els documents de les activitats es desen dins del propi document de Firestore (base64, fins a 500 KB). Així ens mantenim al pla gratuït Spark, sense targeta. No s'activa Storage ni es despleguen regles seves.

L'app antiga (`src/`, `views/`, Express) es queda intacta. Aquesta és independent i no la trenca.

**URL publicada:** https://llibreta-mates.web.app (pla gratuït Spark, sense targeta).

## Provar-ho al teu equip ara mateix

Si vols provar-ho sense Firebase, posa `VITE_LOCAL_DEMO=true` a `web/.env.local`. Ara mateix ja està configurat amb el projecte real `llibreta-mates`, així que cal tenir Authentication i Firestore actius.

```bash
cd web
npx vite --port 5173
```

Obre http://localhost:5173 i entra amb:

- Correu: `profe@test.cat`
- Contrasenya: `prova12345`

En mode local (`VITE_LOCAL_DEMO=true`) les dades es desan al navegador (`localStorage`), no es connecta a Firebase i no cal cap compte. Pots veure el Principal, triar un grup i entrar al Taulell.

> `VITE_LOCAL_DEMO=true` és **només per provar en local**. No ho puguis a Firebase. Amb `false` es fan servir les dades reals de `llibreta-mates`.

## Penjar-ho a Firebase, pas a pas (gratis, sense targeta)

### 1. Crea el projecte

1. Vés a https://console.firebase.google.com i inicia sessió amb un Google.
2. **Afegeix un projecte** → nom, per exemple `llibreta-mates`.
   - Pots desactivar Google Analytics si no el vols.
   - Tria el pla **Spark** (gratuït). No demana targeta.
3. L'ID del projecte és únic al món: si `aula-dia-a-dia` ja està agafat, Firebase et proposarà un altre nom. Copia l'ID real.

### 2. Activa Authentication

1. Al menú esquerre: **Compilació → Authentication**.
2. **Comença** → pestanya **Sign-in method**.
3. Activa **Correu electrònic/Contrasenya** → **Desa**.

### 3. Activa Firestore

1. **Compilació → Firestore Database** → **Crea base de dades**.
2. Mode: **Producció**. Ubicació: tria una d'Europa (per exemple `europe-west3 Frankfurt`).
3. De moment surt una regla per defecte; la substituirem en desplegar amb `firestore.rules`.

### 4. No cal activar Storage

L'app **no fa servir Firebase Storage**: els fitxers de les activitats viuen dins de Firestore (màxim 500 KB per fitxer). No facis res en aquest pas. Si encara tens el fitxer antic `web/storage.rules`, és innòcu i no es desplega.

### 5. Afegeix l'app web i copia la configuració

1. **Configuració del projecte** (la roda dentada) → **Les teves apps** → icona `</>` (Web).
2. Registra l'app (nom, per exemple `aula-web`). No cal que activis Hosting des d'aquest pas.
3. Copia l'objecte `firebaseConfig` que surt.

### 6. Configura el projecte local

Copia `web/.env.example` a `web/.env.local` i omple-ho:

```env
VITE_LOCAL_DEMO=false
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=llibreta-mates.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=llibreta-mates
VITE_FIREBASE_STORAGE_BUCKET=llibreta-mates.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abcdef
```

A més, posa l'ID real a `web/.firebaserc`:

```json
{
  "projects": { "default": "llibreta-mates" }
}
```

### 7. Desplega

```bash
cd web
npm install
npx firebase-tools login
npm run deploy
```

`npm run deploy` fa `npm run build` i després puja:

- el codi a **Hosting** (`dist/`),
- les regles de **Firestore**. Storage no es desplega perquè no s'utilitza.

Al final et dirà l'URL, que serà:

```
https://llibreta-mates.web.app
```

També pots connectar el repositori de GitHub des de **Hosting → Connecta amb GitHub** per desplegar automàticament a cada `push`. Primer hauràs de pujar el codi a GitHub (Git encara no està instal·lat en aquest equip).

### 8. Primer ús

En obrir l'URL per primera vegada, l'app crea automàticament:

- el compte de proves `profe@test.cat` / `prova12345`,
- 6 grups de mostra amb colors.

El compte de proves no es pot esborrar des de l'app.

### Registre des de l'app

A la pantalla de login, **Ets professor? Registra’t amb el teu codi** obre el formulari de registre.

- **Només professorat** es pot registrar des de l'app, i **sempre amb un codi d'accés**. El codi actual és `AULA-2026` i es defineix a la constant `TEACHER_REGISTRATION_CODE` de `web/src/App.jsx` (canvia'l allà i torna a desplegar quan vulguis).
- En registrar-se es creen automàticament els grups bàsics i l'horari, i el doc de l'usuari es desa amb `role: 'teacher'`.
- **Els alumnes NO es registren sols**: entren només per invitació del professor (enllaç `?invite=CODI` o correu automàtic).

Les dades de cada professor estan separades per `teacherId`. Els comptes que ja no vulguis es poden eliminar des de **Firebase Console → Authentication → Users**. El compte de proves `profe@test.cat` continua funcionant com a professor permanent.

## Què falta encara (properes fases)

- Fase 2: horari, sessions i activitats a Firestore. L'horari ja és editable (grups i hores, amb mode Edita) i es desa a Firestore; les guàrdies i reunions ja no hi apareixen. La gestió (horari i cursos, colors i classes) està a la Principal; dins d'un grup només hi ha Tauler, Sessions, Activitats i Lliuraments. A sota de l'horari hi ha el gestor de cursos: **Duplica** (copia grups, colors i horari, però no alumnes ni sessions) o **Crea buit** (només el curs amb les hores per defecte).
- **Planificació setmanal**: tant a l'horari general com a *Sessions* d'un grup hi ha un selector de setmana i el botó **Crea sessions**. En prémer el `+` surten dues opcions: **Per setmana** (prepara la setmana visible) i **Per rang de dates**. Les setmanes **comencen sense sessions**: a *Sessions* es mostra un missatge fins que generes sessions. Cada franja de classe es converteix aleshores en una sessió buida amb data (si la sessió ja existeix, no es duplica). Les cel·les de l'horari mostren quantes activitats té la sessió, si està preparada o si està feta; en clicar-les s'obre la sessió. Les sessions es desen a Firestore (col·lecció `sessions`, filtrada per `teacherId`).
- **Generació per rang**: la finestra permet triar **Data d'inici** i **Data de fi**, amb accés ràpid a **1r / 2n / 3r trimestre** i **Tot el curs**. Mostra un recompate de franges abans de generar. Es generen només sessions dels dies laborables que tenguin hores a l'horari; caps de setmana i festes s'ignoren.
- **Dies de festa (gestió global)**: a l'*Horari*, just sota la taula, hi ha el botó compacte **Dies festa**. En prémer-lo s'obre un desplegable amb dues opcions: **Un dia** (en triar la data s'afegeix automàticament) i **Un periode** (tria **Des de** i **Fins al**, p. ex. Nadal, i prem **Afegeix el periode**; mostra quants dies cobreix). Cada festa es desa com a **un sol rang inici–fi**, no com a dies individuals, al document `settings/{uid}` de Firestore (camp `holidayRanges`; el camp antic `holidays` es manté només per compatibilitat). Apareixen just a sota del botó, en vermell petit —p. ex. `22/12 – 23/12`— i clicar el rang el treu sense afectar les altres festes. L'app els té presents internament: no crea sessions aquests dies ni per setmana ni per rang, les cel·les de l'horari mostren «Festa» i no són clicables, i les targetes de *Sessions* les marquen amb la insígnia «Festa».
- **Sortir i tornar a entrar**: en tancar la sessió i tornar a entrar, el professor sempre comença a la pàgina inicial per triar el grup. El grup actiu és només de la sessió del navegador i no es desa al perfil de Firestore.
- **Capçalera del grup**: dins d'un grup, la capçalera mostra sempre el nom de la classe amb el seu color (sense contorn) i, just a sota, el nom de la pàgina on ets (*Inici*, *Sessions*, *Activitats* o *Lliuraments*).
- **Inici del grup**: en entrar a un grup, la pàgina *Inici* mostra un tauler amb la sessió **d’aquest grup** per avui, els alumnes, les activitats pendents i un resum. Si avui no hi ha cap franja d’aquest grup a l’horari, posa «Avui no hi ha classe»; si hi ha classe però encara no s’ha generat la sessió, ho indica i ofereix la propera sessió. El recompte de «sessions d’aquest grup aquesta setmana» només compta les sessions del grup obert, no les dels altres grups.
- **Targetes de sessió**: a *Sessions* les sessions de la setmana es mostren com a fulls de llibreta a tot l'ample, amb dia i hora a l'esquerra i l'explicació i les activitats a la dreta, en lloc de caixes petites. Ja no surt l'etiqueta «Buida»: si la sessió està marcada com a **Feta**, apareix una marca verda amb l'icona de verificació; si només està **Preparada** (té explicació o alguna activitat amb descripció), apareix una icona de bandera en blau fosc. Això es mostra a la targeta, a la cel·la de l'horari i al tauler d'*Inici*. Si només té activitats sense descripció, es mostra el recompte en blau.
- **Dins d'una sessió** l'ordre és simple: primer el botó **Segueix una sessió anterior** (si el premes, queda marcat i mostra quina sessió del dia segueix, amb un desplegable per canviar-la; si el tornes a prémer, es desmarca), després l'**explicació / teoria** amb enllaços o recursos, després les **activitats** i, al final, el **Diari final · resum**. En prémer **Desa la sessió**, la fitxa es desa i la pantalla es tanca automaticament. El vincle amb la sessió anterior només és una referència al diari: no afegeix ni mou activitats.
- **Activitats d'una sessió**: hi ha tres opcions —**Del banc** (amb cercador i filtres d'etiquetes), **Activitat nova (PDF)** i **Activitat de pissarra** (icona de càmera). En les dues opcions noves no cal escriure descripció ni etiquetes: només s'adjunta el PDF o la foto i es prem **Afegeix a la sessió**. La foto es redueix per cabre al límit de 500 KB i es pot previsualitzar abans de desar. L'activitat s'afegeix **directament a la sessió** i queda al banc amb l'estat **Pendent de validar** i el seu tipus; la descripció i les etiquetes les pots posar després en editar-la al banc. Les dades opcionals de cada activitat dins la sessió (enunciat, instruccions i data límit) estan plegades sota **Detalls opcionals**. Les activitats pendents no surten al selector del banc fins que les gestiones.
- Classes permet crear i esborrar grups, canviar-ne el color i **reanomenar-los amb el llapis que hi ha al costat del títol** (es desa en prémer Enter o en sortir del camp; Esc cancel·la). També permet convidar alumnes amb un enllaç únic, treure alumnes d'un grup, regenerar invitacions i enviar restabliments de contrasenya. L'alumne tria la contrasenya; per seguretat no es desa en clar.
- A la Principal, els accessos **Horari**, **Classes** i **Banc d'activitats** es mostren en una sola fila i a la mateixa alçada (en pantalles estrets s'apilen).
- **Importació en bloc**: a Classes → *Importa una llista des de l'Excel / CSV* pots enganxar files directament de l'Excel (`nom<tab>correu`) o pujar un `.csv` amb columnes `Nom, Correu`. Es conviden tots els alumnes del grup seleccionat (màxim 50 per vegada). El fitxer es processa al navegador; no s'envia a cap servidor de pagament.
- En convidar un alumne es crea el seu compte d'Authentication i Firebase envia automàticament un correu (de `noreply@…firebaseapp.com`) perquè triï la contrasenya. També pots copiar l'enllaç o prémer **Obre el correu** per enviar-lo des del teu propi correu. Si el correu automàtic falla, l'app ho indica i conserva l'enllaç.

### Menú de grup i mòbil

Quan entres en un grup, el menú (**Inici**, **Sessions**, **Activitats**, **Lliuraments**) queda **a l'esquerra**, no a dalt.

- A l'ordinador (i a qualsevol dispositiu amb ratolí / punter fi), la barra lateral és **sempre visible** i no hi ha cap botó per plegar-la, encara que la finestra sigui estreta.
- Només en **dispositius mòbils** (punter tàctil o agent d'usuari mòbil, amb pantalla de fins a 900 px), el menú és un **calaix esquerre**: el botó de la cantonada l'obre, un fons fosc el tanca en clicar-hi, i també es tanca amb **Esc** o en prémer qualsevol opció. Mentre és obert, no es pot fer scroll del fons.
- No hi ha cap menú horitzontal de grups a la part superior.

### Espai de l'alumne

L'alumne ja no veu una pantalla buida: en entrar amb el seu correu i contrasenya veu:

- el **nom del seu grup** (amb la matèria i el nivell) i el curs, pres del seu doc d'usuari o de la seva fitxa d'alumne;
- la llista d'**activitats pendents** assignades a les sessions d'aquest grup, amb data límit, enunciat, instruccions i l'hora de la sessió;
- els fitxers adjunts de l'activitat es poden **previsualitzar** i baixar amb **Baixa’l**, igual que al banc del professor.

Les dades són de només lectura per a l'alumne: no pot modificar grups, sessions ni activitats. Si encara no té grup assignat, veu un missatge explicatiu i s'hi associarà automàticament en obrir un enllaç d'invitació nou.

### Banc d'activitats (repositori personal)

Des de la Principal → **Banc d'activitats** tens un repositori només per al professor, **totalment independent de cursos, grups, horaris, alumnes i dates**. Cada professor només veu les seves activitats (a Firestore, col·lecció `activities`, filtrada per `teacherId`).

- **Nova activitat**: títol, contingut lliure (enunciat, passos, materials, solucionari…) i etiquetes.
- **Cercador** per paraules del títol (ignora majúscules i accents).
- **Filtre d'etiquetes**: pots marcar-ne una o vàries alhora; només surten les activitats que tenen *totes* les etiquetes marcades. **Neteja els filtres** ho resetja.
- Cada targeta té **Edita**, **Duplica** (crea una còpia amb el títol «(còpia)») i **Esborra** (amb confirmació).
- **Pendents de validar**: les activitats creades desde una sessió apareixen **primera** al banc, amb una insígnia «Pendent de validar» i un recompte al capdamunt. Pots **Edita**-les per posar-hi les etiquetes i la descripció que vulguis, **Afegeix al banc** per donar-les per bona (aleshores ja surten al selector de sessions) o **Esborra**-les si no les vols conservar. Mentre són pendents, la targeta no té el botó **Duplica**.

**Adjunt de cada activitat**: en crear o editar una activitat, tria primer **Document (PDF)** o **Activitat de pissarra**. Amb **Document (PDF)**, **Puja un document (títol i etiquetes del nom)**: no es llegeix el contingut, el títol surt directament del nom del fitxer (sense l'extensió, amb `-` i `_` convertits en espais) i les etiquetes es proposen a partir d'aquest títol; tu només has d'acabar la descripció. Amb **Activitat de pissarra**, **Afegeix una foto** des de la càmera o la galeria: es comprimeix automàticament per no superar els 500 KB i es mostra amb la icona de càmera. L'adjunt queda desat amb l'activitat i la targeta mostra el nom del fitxer: **clica-hi per veure'n una previsualització** al navegador (foto o PDF), i després **Baixa’l** si el vols guardar (abans es baixava directament). També pots previsualitzar l'adjunt mentre edites, abans de desar. En mode document hi ha un botó **Torna a proposar títol i etiquetes del nom** si vols repetir-ho. Les etiquetes de cada activitat es mostren en petit i en negre a sota de la targeta.

Límit del pla gratuït: Firestore permet fitxers de fins a 500 KB adjunts (codificats dins del document). Si el fitxer és més gran, no s'adjunta i l'app ho avisa. No es fa servir Firebase Storage ni cap servei de pagament.

**Sobre les etiquetes i la IA**: no s'usa cap IA. Les etiquetes les proposes tu en crear o editar l'activitat, triant les suggerides o escrivint-ne de noves. El suggeriment automàtic en pujar el document i el botó **Suggereix etiquetes a partir del títol i la descripció** només reconeixen paraules clau (p. ex. «fraccions», «equació», «geometria»); és una ajuda local i gratuïta, i sempre pots afegir o treure etiquetes a mà. Si una activitat antiga no tenia etiquetes desades, es mostren les que es dedueixen del seu títol.

### Correu d'invitació en català (plantilla de Firebase)

L'enviament automàtic gratuït fa servir el correu de restabliment de contrasenya de Firebase, però **el text de la plantilla es pot editar** perquè sembli una invitació de registre i estigui en català:

1. **Firebase Console → Authentication → Templates** (pestanya *Templates*).
2. Selecciona **Password reset** (i, si apareix, la versió **Catalan**; si no, edita la plantilla per defecte).
3. Assumpte: `Invitació a la classe · %APP_NAME%`
4. Cos (HTML):

```html
<p>Hola,</p>
<p>Has rebut una invitació per entrar a <strong>%APP_NAME%</strong>. Fes clic a l'enllaç de sota i tria la teva contrasenya per crear el compte:</p>
<p><a href="%LINK%">Crea el meu compte</a></p>
<p>Un cop fet, entra amb el correu <strong>%EMAIL%</strong> i la contrasenya que hagis triat.</p>
<p>Si no esperaves aquest correu, pots ignorar-lo.</p>
```

El codi fixa `auth.languageCode = 'ca'` perquè Firebase intenti fer servir la plantilla catalana. L'enllaç continua passant per Firebase (és el mecanisme gratuït disponible); el que canvia és el text que rep l'alumne. Un correu 100% personalitzat amb remitent propi requeriria un servei extern de correu.
- Fase 3: lliuraments. De moment l'apartat **Lliuraments** és el punt d'entrada previst; no s'afegeixen fitxers nous perquè no es fa servir Storage (caldria pla Blaze).
- Fase 4: qualificacions i comentaris.
- Fase 5: gestió avançada de cursos escolars (crear, duplicar i triar curs ja funciona des de l'horari).

El pla gratuït de Firebase (Spark) inclou Hosting, Authentication, Firestore i Storage amb límits generosos per a un projecte de classe. El domini `web.app` és gratis. Si més endavant vols un domini propi (`el-teu-domini.com`), Firebase pot requerir el pla Blaze (targeta); ho deixem per quan ho decideixis.
