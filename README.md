# Aula dia a dia

Plataforma web en català per a l'ús quotidià a l'aula de secundària i batxillerat: horari, grups, sessions, activitats, lliuraments i avaluació.

## Dues versions

- **`web/` (nova, recomanada)**: React + Firebase Hosting, igual que la pàgina del teu amic. Domini gratis `*.web.app`, sense targeta i amb desplegament per fases. Veu [`web/README.md`](web/README.md) per provar-la i penjar-la.
- **Arrel del projecte (versió actual)**: Express + EJS + SQLite/libSQL, ja preparada per Vercel + Turso + Supabase. Segueix funcionant igual i no s'ha tocat.

## Com funciona l'accés

- **Professorat:** en entrar veu **Principal**, amb les targetes `Horari` i `Classes` i els grups del curs actiu. Ha de triar un grup (o crear-ne un) per continuar.
- Un cop triat el grup, la barra lateral es desplega i apareix **Taulell** (de moment en blanc). Tauler, sessions, activitats i lliuraments mostren només les dades d'aquest grup.
- El botó de tancar sessió és l'únic element a la dreta de la capçalera.
- **Alumnat:** entra directament a les seves classes i lliuraments amb el codi que li dona el professor.

## Mòduls inclosos (v0.1)

- **Principal i Taulell**: selecció de grup abans de gestionar i espai de treball buit preparat per creixer.
- **Classes**: creació de grups amb codi d'accés, matrícula per correu o codi i color assignable (es mostra a l'horari, sessions i lliuraments).
- **Horari setmanal**: plantilla editable en forma de taula (classe, guàrdia o reunió), importable/exportable en CSV i amb generació de sessions datades d'un rang. No duplica sessions ja generades.
- **Cursos escolars**: curs actiu amb dades separades per `school_year`. En crear un curs nou es pot copiar l'horari i la biblioteca d'activitats, mai alumnes ni notes. Canviar de curs deixa el grup sense seleccionar i torna a Principal.
- **Sessions**: planificació per data, hora i classe, objectius, notes, estat i activitats assignades amb data límit.
- **Biblioteca d'activitats**: títol, descripció, matèria, nivell, tipus, dificultat, durada, objectius i etiquetes; cerca i filtres.
- **Lliuraments**: l'alumne pot escriure la resposta i adjuntar un fitxer (PDF, Word, ODT, TXT, imatge o ZIP, fins a 10 MB).
- **Avaluació**: el professor desa una nota (0–10) i comentaris; l'alumne veu el resultat.

No s'hi inclou generació d'activitats amb IA.

## Requisits i stack

- Node.js 22.5 o superior.
- Express 5 + EJS + Multer.
- Dades: SQLite compatible amb libSQL (`@libsql/client`). En local, fitxer `data/aula.db`; a producció, **Turso**.
- Fitxers pujats: `data/uploads/` en local; **Supabase Storage** a producció.

## Posada en marxa local

```bash
npm install
npm start
```

Obre <http://localhost:3100>. No cal cap compte extern.

**Compte de proves (es crea sol en arrencar):**
- Correu: `profe@test.cat`
- Contrasenya: `prova12345`

El compte es manté entre reinicis i ja té importada la plantilla d'horari del curs `2026-2027`. No s'esborra mai automàticament.

Per registrar un altre professor: **Crea'n un** a la pantalla de login. En registrar-se s'importa la plantilla d'horari amb els grups `2n ESO D`, `2n ESO C`, `1r BATX Ciències`, `4t ESO D-E` i `4t ESO A-B-C`. Després, des de **Principal**, tria el grup que vols gestionar.

Altres comandes:

```bash
npm run dev                                   # recàrrega automàtica
npm run horari                                # generar sessions, properes 4 setmanes
npm run horari 2026-11-23 2026-12-20
npm run reset                                 # ESBORRA TOTES LES DADES
```

> **Atenció:** `npm run reset` esborra tots els usuaris llevat del professor de proves. No l'executis si vols conservar el teu compte.

## Desplegament gratuït (Vercel + Turso + Supabase)

El codi pot viure al teu repositori; la base de dades i els fitxers no. Vercel té el sistema de fitxers de lectura i `/tmp` és temporal, així que un `aula.db` al repo no podria desar canvis. Per això fem servir serveis externs gratuïts (sense targeta):

| Servei | Què fa | Pla gratuït |
|---|---|---|
| **Vercel** | codi, HTTPS i domini `el-teu-nom.vercel.app` | gratis |
| **Turso** | base de dades SQLite al núvol | 5 GB, 100 bases |
| **Supabase Storage** | fitxers pujats | 1 GB |

### 1. Puja el codi a GitHub

```bash
git init
git add .
git commit -m "Aula dia a dia: Principal, Taulell i desplegament gratuït"
git remote add origin https://github.com/EL_TEU_USUARI/EL_TEU_REPO.git
git push -u origin main
```

`data/`, `.env` i `node_modules/` ja estan exclosos per `.gitignore` i `.vercelignore`. No puguis la base de dades al repo: conté correus i contrasenyes.

### 2. Turso (base de dades)

1. Instal·la l'eina de línia d'ordres de Turso i identifica't amb GitHub: `turso auth signup` o `turso auth login`.
2. Crea la base: `turso db create aula-dia-a-dia`.
3. Copia l'URL: `turso db show aula-dia-a-dia --url`.
4. Crea un token: `turso db tokens create aula-dia-a-dia`.

Si vols migrar les dades locals existents:

```bash
sqlite3 data/aula.db ".dump" > aula.sql
turso db shell aula-dia-a-dia < aula.sql
```

A Vercel, afegeix `LIBSQL_URL` i `LIBSQL_AUTH_TOKEN` amb aquests valors. La primera petició a l'app crea les taules que faltin i el compte de proves si no existeix.

### 3. Supabase Storage (fitxers)

1. Crea un projecte gratuït a Supabase.
2. A **Storage**, crea un bucket privat anomenat `lliuraments` (si no existeix, l'app el crea sola).
3. A **Project Settings → API**, copia l'URL del projecte i la clau `service_role` (no la faig servir al navegador).

A Vercel, afegeix `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` i, si vols un altre nom de bucket, `SUPABASE_BUCKET`.

### 4. Vercel

1. **Add New → Project** i importa el repo de GitHub.
2. A **Environment Variables**, afegeix:
   - `NODE_ENV=production`
   - `SESSION_SECRET=` (cadena llarga i aleatòria; l'app es nega a arrencar si falta)
   - `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET=lliuraments`
3. Desplega. Vercel et dona l'URL `https://el-teu-nom.vercel.app` gratis. Pots afegir-hi el teu domini si en tens un.

Hi ha un fitxer `.env.example` amb totes les variables. No el pugin amb valors reals.

### Límits dels plans gratuïts

- Els projectes gratuïts es poden posar en pausa per inactivitat; la primera visita després d'una pausa pot trigar uns segons.
- No hi ha SLA ni còpies automàtiques garantides. Fes exportacions periòdiques de la base (`turso db shell ... .dump`) si les dades són importants.
- Aquest muntatge és per a ús docent i proves. Abans de fer-lo servir de veritat amb menors, cal revisar el compliment de RGPD.

## Estructura

```
api/index.js           punt d'entrada a Vercel
src/app.js             middleware global, arrencada i gate de Principal
src/db.js              adapter asíncron: SQLite local o Turso
src/storage.js         fitxers: disc local o Supabase Storage
src/reset.js           esborra totes les dades
src/courses.js         curs actiu, separació i còpia de cursos
src/colors.js          paleta de colors per als grups
src/auth.js            sessions, CSRF i cookies
src/security.js        contrasenyes i signatures
src/util.js            formatació de dates, etiquetes, etc.
src/horari.js          plantilla d'horari i generació de sessions
src/routes/            rutes d'autenticació, Principal, cursos, horari, classes, activitats, sessions i lliuraments
views/                 plantilles EJS
public/                CSS i JavaScript del navegador
data/                  base de dades i fitxers pujats en local (no versionat)
vercel.json            reescriptura de tot el trànsit a l'app Express
```

## Seguretat i dades personals

- Contrasenyes desades amb `scrypt` i sal aleatòria.
- Sessions en cookies `httpOnly`, `secure` a producció, amb signatura HMAC i token CSRF als formularis.
- Control d'accés per rol, curs i grup a totes les rutes.
- Els fitxers només es poden descarregar amb sessió vàlida i permís; a producció no estan exposats públicament.
- La clau `service_role` de Supabase només s'usa al servidor.
