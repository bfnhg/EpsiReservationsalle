# EPSI — Réservation des salles

Application responsive de réservation de salles de campus. Les étudiants peuvent créer un compte, vérifier les disponibilités, réserver un créneau, recevoir une confirmation par e-mail, retrouver leurs réservations, les modifier et les annuler.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Technologies et architecture](#technologies-et-architecture)
- [Prérequis et installation](#prérequis-et-installation)
- [Configurer les e-mails EmailJS](#configurer-les-e-mails-emailjs)
- [Utilisation](#utilisation)
- [API HTTP](#api-http)
- [Données et règles de réservation](#données-et-règles-de-réservation)
- [Sécurité et vie privée](#sécurité-et-vie-privée)
- [Responsive et accessibilité](#responsive-et-accessibilité)
- [Commandes et production](#commandes-et-production)
- [Dépannage](#dépannage)
- [Structure du projet](#structure-du-projet)

## Fonctionnalités

- Inscription et connexion des étudiants par e-mail et mot de passe.
- Recherche de salles selon la date, l’heure, la durée, la capacité minimum et l’accès PMR.
- Création atomique de réservation : deux étudiants ne peuvent pas obtenir une même salle sur des créneaux qui se chevauchent.
- E-mail de confirmation EmailJS après réservation, avec salle, bâtiment, date, heures et référence.
- E-mail de confirmation actualisé après modification.
- Messagerie intégrée entre les étudiants et l’administration, avec notifications e-mail EmailJS.
- Consultation de l’historique personnel, modification et annulation d’une réservation.
- Ajout et retrait de salles dans les favoris, conservés par compte.
- Ajout d’une réservation confirmée à Google Calendar via un événement prérempli, ou export au format `.ics`.
- Espace d’administration protégé par rôle : ajout, modification, désactivation et réactivation des salles.
- Paramétrage des durées minimale et maximale ainsi que du délai de prévenance des réservations.
- Tableau de bord administrateur : disponibilités selon un créneau, réservations avec l’étudiant concerné, historique complet et favoris regroupés par élève.
- Données et historique isolés par compte.
- Interface française adaptée aux écrans mobiles, tablettes et ordinateurs.

## Technologies et architecture

- **Interface** : React 19, TypeScript, Vite et CSS responsive.
- **Serveur** : Node.js, Express 5, TypeScript.
- **Persistance** : SQLite via `sql.js` en local, Neon PostgreSQL en ligne.
- **Authentification** : mot de passe haché avec bcryptjs et jeton JWT dans un cookie HTTP-only.
- **E-mail** : SDK navigateur `@emailjs/browser`. EmailJS envoie les e-mails au moyen du service et du modèle configurés dans le compte EmailJS.

L’interface appelle les routes `/api` du serveur. En développement, Vite transmet ces requêtes à `http://localhost:3001`. Sur Vercel, les fichiers compilés de `dist/client` sont servis comme site statique et une fonction Express gère les routes API ; les données sont conservées dans Neon PostgreSQL. En local, l’application utilise SQLite tant que `DATABASE_URL` n’est pas défini.

## Prérequis et installation

- Node.js 22 ou plus récent et npm.
- Un compte EmailJS et un service de messagerie configuré pour envoyer les confirmations.

Depuis la racine du projet :

```powershell
npm install
Copy-Item .env.example .env
```

Ouvre `.env` et configure au minimum `JWT_SECRET` avec une chaîne aléatoire longue d’au moins 32 caractères. Ajoute ensuite les trois identifiants EmailJS décrits dans la section suivante.

Démarre le serveur et l’interface :

```powershell
npm run dev
```

Ouvre l’URL Vite indiquée dans le terminal, en général [http://localhost:5173](http://localhost:5173). Si ce port est déjà occupé, Vite choisit automatiquement le suivant.

La première exécution locale crée `data/reservations.sqlite` ainsi que cinq salles de démonstration. Avec `DATABASE_URL`, le schéma est créé dans Neon et les cinq salles sont ajoutées si la base est vide. La base Neon est distincte du fichier SQLite local : aucune donnée locale, aucun compte et aucun historique ne sont copiés automatiquement. N’utilise pas de données réelles d’étudiants dans une base de démonstration.

## Configurer les e-mails EmailJS

Sans ces identifiants, la réservation reste enregistrée, mais l’interface indique que le courriel n’a pas pu être envoyé. EmailJS n’est pas simulé : il faut connecter un service et un modèle réels à ton compte pour que les messages soient expédiés.

### Configuration de cette application

Le fichier `.env` local est configuré avec le service Gmail EmailJS `service_qbth65h` et le modèle `template_i0qqtkp`. La clé publique reste dans le fichier `.env` local et n’est volontairement pas copiée dans cette documentation. Ne partage pas et ne publie pas ce fichier.

1. Dans EmailJS, ajoute et vérifie un **service e-mail** (par exemple un fournisseur SMTP ou une intégration prise en charge).
2. Crée un **modèle d’e-mail** et configure son destinataire avec `{{to_email}}`. Tu peux utiliser `{{to_name}}` comme nom du destinataire.
3. Configure par exemple l’objet du message comme `Confirmation de réservation EPSI — {{room_name}} — {{booking_date}}`, puis écris le corps avec ces variables du modèle :

   | Variable | Contenu |
   | --- | --- |
   | `to_email` | Adresse du compte étudiant |
   | `to_name` | Nom de l’étudiant |
   | `room_name` | Salle réservée |
   | `building` | Bâtiment et étage |
   | `booking_date` | Date formatée en français |
   | `start_time` | Heure de début |
   | `end_time` | Heure de fin |
   | `reservation_id` | Référence complète de la réservation |

   Exemple de contenu de modèle :

   ```text
   Bonjour {{to_name}},

   Votre réservation est confirmée :
   Salle : {{room_name}}
   Lieu : {{building}}
   Date : {{booking_date}}
   Horaire : {{start_time}} - {{end_time}}
   Référence : {{reservation_id}}
   ```

4. Dans les réglages EmailJS, limite les domaines autorisés à ceux de ton application publiée et configure les protections anti-abus disponibles.
5. Renseigne les valeurs suivantes dans `.env` :

   ```dotenv
   VITE_EMAILJS_SERVICE_ID=service_xxxxxxx
   VITE_EMAILJS_TEMPLATE_ID=template_xxxxxxx
   VITE_EMAILJS_CONTACT_TEMPLATE_ID=template_contact_xxxxxxx
   VITE_EMAILJS_PUBLIC_KEY=xxxxxxxxxxxxxxx
   ```

6. Redémarre `npm run dev` après toute modification des variables `VITE_`.
7. Inscris-toi avec une adresse que tu peux consulter, effectue une réservation et vérifie la boîte de réception ainsi que les courriers indésirables.

La clé `VITE_EMAILJS_PUBLIC_KEY` est une clé publique destinée au navigateur, pas un mot de passe. Elle sera incluse dans le code client compilé et ne doit donc jamais être considérée comme un secret. Ne mets jamais de clé privée EmailJS, mot de passe SMTP ou identifiant de fournisseur dans une variable `VITE_`. Le serveur autorise `https://api.emailjs.com` dans sa politique CSP pour l’appel du SDK.

La réservation est enregistrée **avant** l’appel EmailJS. Si le fournisseur est indisponible ou rejette le message, l’application ne supprime pas la réservation : la fenêtre de confirmation affiche l’échec et l’adresse destinataire, et l’historique reste accessible.

### Messages entre étudiants et administration

Crée un deuxième modèle EmailJS pour les notifications de contact. Configure `{{to_email}}` comme destinataire ; le sujet et le corps peuvent utiliser `{{to_name}}`, `{{from_name}}`, `{{from_email}}` et `{{message}}`. Ajoute l’identifiant du modèle à `VITE_EMAILJS_CONTACT_TEMPLATE_ID`, puis redémarre l’application.

L’étudiant ouvre l’onglet **Contact** pour échanger avec l’administration. Les messages sont conservés dans la base configurée (SQLite localement ou Neon en ligne) et le fil s’actualise automatiquement toutes les 3 secondes. Dans l’onglet **Messages**, un administrateur connecté voit les demandes sous forme de tableau (étudiant, dernier message, date et nombre de messages), puis ouvre une conversation pour répondre. Les routes de lecture et de réponse exigent une session et vérifient le rôle administrateur côté serveur. Les réponses sauvegardées apparaissent dans le fil de l’étudiant. EmailJS envoie les notifications au premier compte administrateur créé et à l’étudiant destinataire. Si EmailJS échoue, le message reste dans la conversation et l’interface signale l’échec de la notification.

Exemple de corps du modèle :

```text
Message EPSI de {{from_name}} ({{from_email}}) à l’attention de {{to_name}} :

{{message}}
```

## Utilisation

1. Crée un compte étudiant ou connecte-toi.
2. Sélectionne une date, une heure de début et une durée comprise entre 30 minutes et 4 heures.
3. Facultativement, filtre par capacité et accessibilité PMR.
4. Choisis une salle disponible et clique sur **Réserver**.
5. La réservation apparaît dans l’historique. Une fenêtre confirme l’opération et indique le statut d’envoi du courriel.
6. Dans **Mes réservations**, modifie la salle, la date, l’heure ou la durée, ou annule le créneau. Une modification réussie déclenche l’envoi d’un récapitulatif actualisé.
7. Utilise le cœur sur une carte pour gérer tes salles favorites. L’onglet **Favoris** les retrouve et précise si elles sont disponibles sur le créneau sélectionné.
8. Dans l’historique, **Google Calendar** ouvre un événement prérempli (salle, lieu, horaires et référence) que tu peux enregistrer dans ton agenda. **Exporter .ics** télécharge aussi un fichier compatible avec d’autres calendriers.
9. Depuis **Contact**, envoie un problème de réservation et retrouve la réponse dans le fil de discussion.

L’ajout Google Calendar ouvre la page de création de l’événement dans Google ; il ne demande aucun accès à ton compte ni OAuth. Tu dois confirmer l’enregistrement dans Google Calendar. Une modification ou une annulation de la réservation EPSI ne met pas à jour automatiquement un événement déjà ajouté ; supprime-le ou modifie-le manuellement dans Google Calendar, ou ajoute un nouvel événement après modification.

### Administration

L’administration n’est pas attribuée à l’inscription. Crée d’abord un compte normal, arrête le serveur, puis promeus explicitement ce compte avec son adresse e-mail :

```powershell
npm run admin:promote -- administrateur@epsi.fr
npm run dev
```

Reconnecte-toi : l’administrateur arrive directement sur son **Tableau de bord admin**, qui affiche les salles disponibles et réservées pour le créneau sélectionné (avec le nom et l’e-mail de l’élève concerné), l’historique de toutes les réservations (confirmées ou annulées) et les favoris regroupés par élève. Les pages étudiant (réservation, favoris et historique personnel) ne sont pas proposées dans la navigation admin. Le tableau permet aussi d’ajouter ou modifier une salle, de la désactiver/réactiver et de régler les durées (par pas de 30 minutes) ainsi que le délai de prévenance. Ces contrôles sont appliqués côté serveur à la recherche, à la création et à la modification de réservation. Pour retirer le rôle, arrête le serveur et exécute `npm run admin:demote -- administrateur@epsi.fr`, puis redémarre-le. Les commandes modifient un compte existant ; elles ne créent pas de compte.

Les créneaux proposés dans l’interface vont de 07 h à 17 h. Le serveur vérifie le futur, les règles actives et l’absence de conflit avant toute réservation.

## API HTTP

Les réponses JSON d’erreur contiennent un champ `error` lisible. Les routes protégées attendent le cookie de session créé lors de l’inscription ou de la connexion.

| Méthode | Route | Accès | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | Public, limité en fréquence | Créer un compte et ouvrir une session |
| `POST` | `/api/auth/login` | Public, limité en fréquence | Ouvrir une session |
| `POST` | `/api/auth/logout` | Public | Fermer la session |
| `GET` | `/api/auth/me` | Connecté | Récupérer l’identité du compte courant |
| `GET` | `/api/booking-rules` | Connecté | Lire les règles de réservation appliquées |
| `GET` | `/api/rooms?startsAt=…&endsAt=…` | Connecté | Rechercher les salles disponibles ; filtres optionnels `capacity`, `accessible` |
| `POST` | `/api/reservations` | Connecté | Créer une réservation |
| `GET` | `/api/reservations` | Connecté | Lister uniquement les réservations du compte courant |
| `PUT` | `/api/reservations/:id` | Propriétaire connecté | Modifier une réservation active et vérifier les conflits |
| `DELETE` | `/api/reservations/:id` | Propriétaire connecté | Annuler une réservation active |
| `GET` | `/api/favorites` | Connecté | Lister les salles favorites actives du compte |
| `PUT` / `DELETE` | `/api/favorites/:roomId` | Connecté | Ajouter ou retirer un favori |
| `GET` / `POST` | `/api/messages` | Étudiant connecté | Lire sa conversation ou contacter l’administration |
| `GET` | `/api/admin/rooms` | Administrateur | Lister toutes les salles, actives ou non |
| `GET` | `/api/admin/dashboard?startsAt=…&endsAt=…` | Administrateur | Voir disponibilités, salles réservées sur le créneau avec leurs étudiants, historique et favoris des élèves |
| `GET` | `/api/admin/messages` | Administrateur | Lire les conversations des étudiants |
| `POST` | `/api/admin/messages/:userId` | Administrateur | Répondre à un étudiant |
| `POST` / `PUT` / `DELETE` | `/api/admin/rooms[/:id]` | Administrateur | Créer, modifier, désactiver ou réactiver une salle |
| `GET` / `PUT` | `/api/admin/settings` | Administrateur | Lire ou modifier les règles globales de réservation |

Une requête de création ou de modification de réservation contient `roomId`, `startsAt` et `endsAt`. Les dates ISO avec fuseau horaire sont normalisées en UTC côté serveur. Le filtre `excludeReservationId`, utilisé uniquement pendant la modification, est accepté seulement si la réservation appartient à l’utilisateur courant.

## Données et règles de réservation

- `users` : identifiant, nom, adresse e-mail unique, hachage du mot de passe et rôle (`student` ou `admin`).
- `rooms` : nom, bâtiment, capacité, accessibilité, équipements et statut actif. La désactivation est logique pour préserver l’historique.
- `reservations` : référence UUID, propriétaire, salle, début, fin et état (`confirmed` ou `cancelled`).
- `room_favorites` : association entre les comptes et leurs salles favorites.
- `support_messages` : conversations et réponses rattachées au compte étudiant et à leur expéditeur.
- `app_settings` : durées minimale/maximale et préavis minimum, avec valeurs par défaut de 30 minutes, 4 heures et aucun préavis.
- Les salles de démonstration sont insérées uniquement si la table `rooms` est vide.
- Les réservations annulées sont conservées dans l’historique, mais ne bloquent plus la salle.
- La création et la modification contrôlent l’absence de chevauchement sous verrou transactionnel par salle (verrou PostgreSQL avec Neon, transaction immédiate avec SQLite). Les intervalles qui se touchent exactement sans chevauchement sont acceptés.
- L’interface d’administration est masquée aux étudiants et chaque route admin vérifie le rôle actuel en base côté serveur. La promotion des comptes se fait uniquement par commande locale, jamais par API publique.
- Le tableau de bord qui révèle l’identité des étudiants et leurs favoris est exclusivement protégé par le rôle administrateur. Ces informations ne sont exposées ni aux comptes étudiants ni aux routes personnelles d’un autre compte.

Sans `DATABASE_URL`, la base locale utilise `DATABASE_PATH` (par défaut `./data/reservations.sqlite`). Avec `DATABASE_URL`, l’application se connecte à Neon PostgreSQL ; Vercel refuse de démarrer si cette variable est absente.

## Sécurité et vie privée

- Mots de passe hachés avec bcryptjs ; ils ne sont jamais renvoyés par l’API.
- Session dans un cookie `HttpOnly`, `SameSite=Strict`, avec l’attribut `Secure` en production HTTPS.
- Les listes de salles et les réservations personnelles exigent une session ; les opérations sur une réservation contrôlent sa propriété côté serveur.
- En-têtes HTTP de sécurité configurés avec Helmet ; les réponses API sont marquées `Cache-Control: no-store`.
- Inscription et connexion sont limitées à 10 tentatives par fenêtre de 15 minutes par instance.
- Les champs reçus sont validés par Zod ; la taille des corps JSON est limitée.
- L’adresse e-mail et les détails de réservation sont transmis à EmailJS afin d’envoyer le message. Configure les règles de confidentialité du fournisseur et ne traite que les données nécessaires.

Pour une mise en production, servir exclusivement en HTTPS, définir un `JWT_SECRET` aléatoire propre à l’environnement, protéger la base Neon, restreindre les domaines autorisés dans EmailJS et surveiller les limites du fournisseur. Le limiteur actuel conserve ses compteurs en mémoire : en multi-instance, configure un stockage partagé. SQLite via `sql.js` est réservé au développement local ; pour les déploiements serverless, configure Neon PostgreSQL.

## Responsive et accessibilité

La mise en page utilise une grille fluide et des points de rupture mobile/tablette (820 px, 700 px et 560 px), accepte les écrans à partir de 320 px de largeur et adapte la navigation, les cartes, les formulaires, l’historique, les fenêtres modales et les panneaux d’administration. Les contrôles ont des libellés, les retours de statut sont annoncés aux technologies d’assistance, la navigation clavier reçoit un indicateur de focus et les animations sont réduites lorsque le système le demande.

Pour tester manuellement, vérifie les vues d’inscription, réservation, historique et modification avec les outils adaptatifs du navigateur à 320 px, 375 px, 560 px, 768 px et sur ordinateur. Vérifie également le clavier, le zoom et un lecteur d’écran.

## Déployer un environnement de test sur Vercel

La configuration Vercel est dans `vercel.json`. Le dépôt doit être poussé vers GitHub, GitLab ou Bitbucket, puis importé dans Vercel. La configuration lance `npm run build`, sert `dist/client` et réécrit les appels `/api/*` vers l’unique fonction Express `api/index.ts`. Les projets sont réglés sur Node.js 22.

### 1. Créer la base Neon

1. Crée un projet PostgreSQL de test dans Neon.
2. Copie la chaîne de connexion PostgreSQL **avec SSL** depuis Neon. Garde-la privée ; ne la colle pas dans le code, un ticket ou le chat.
3. Les tables (`users`, `rooms`, `reservations`, favoris, messages et règles) et cinq salles de démonstration sont créées au premier démarrage de l’application.
4. Les données de `data/reservations.sqlite` ne sont pas migrées. La base distante est initialement vide, en dehors des salles de démonstration et des règles par défaut.

### 2. Importer le projet dans Vercel

1. Pousse le projet dans un dépôt Git privé et importe ce dépôt dans Vercel.
2. Configure les variables suivantes dans **Settings → Environment Variables** pour l’environnement **Preview** (et **Production** uniquement si tu souhaites aussi une URL de production) :

   | Variable | Valeur |
   | --- | --- |
   | `DATABASE_URL` | Chaîne de connexion Neon privée, avec SSL |
   | `JWT_SECRET` | Secret aléatoire unique d’au moins 32 caractères |
   | `NODE_ENV` | `production` |
   | `VITE_EMAILJS_SERVICE_ID` | Identifiant du service EmailJS |
   | `VITE_EMAILJS_TEMPLATE_ID` | Modèle de confirmation de réservation |
   | `VITE_EMAILJS_CONTACT_TEMPLATE_ID` | Modèle de notification de contact |
   | `VITE_EMAILJS_PUBLIC_KEY` | Clé publique EmailJS |

   `DATABASE_URL` et `JWT_SECRET` sont des secrets serveur : ne leur donne pas le préfixe `VITE_`. Seules les variables EmailJS explicitement préfixées `VITE_` sont destinées au navigateur.

3. Lance le déploiement Preview et teste l’inscription, la réservation, les favoris, l’annulation, la messagerie et le rôle admin. Après chaque changement d’une variable `VITE_`, redéploie : ces valeurs sont intégrées au build client.
4. Ajoute le domaine Preview exact dans les origines autorisées EmailJS. Les e-mails ne seront envoyés que si les identifiants et les modèles EmailJS sont valides.

Chaque déploiement Preview utilise les mêmes variables d’environnement Neon Preview que tu lui as attribuées. Utilise une base Neon de test séparée de toute base réelle, limite les accès au projet Vercel et ne mets pas de données d’étudiants réels dans cette démonstration.

### 3. Donner l’accès administrateur

1. Inscris le compte `tuspetiste@necub.com` depuis l’application déployée.
2. Dans Vercel, récupère les variables Preview dans un fichier local non partagé (la commande officielle `vercel env pull .env.vercel` nécessite le CLI Vercel et une authentification au compte). Vérifie que le fichier contient bien `DATABASE_URL` avant de continuer.
3. Depuis la racine du projet, promeus le compte dans la base Neon :

   ```powershell
   $env:DOTENV_CONFIG_PATH = ".env.vercel"
   npm run admin:promote -- tuspetiste@necub.com
   Remove-Item Env:DOTENV_CONFIG_PATH
   ```

   La commande utilise la base indiquée dans ce fichier et ne crée pas de compte ; elle modifie uniquement un compte déjà inscrit. N’ajoute pas un endpoint public de promotion administrateur. Il n’est pas nécessaire de redéployer : déconnecte/reconnecte simplement le compte pour charger son rôle.

Pour révoquer l’accès, exécute `npm run admin:demote -- tuspetiste@necub.com` avec la même base Neon configurée.

### 4. Déployer via le CLI (optionnel)

Après avoir installé le CLI Vercel, relié le dossier au projet (`vercel link`) et défini les secrets dans les réglages Vercel, utilise `vercel --prod` pour un déploiement de production. Le CLI doit être authentifié au compte qui possède le projet. Les déploiements Preview automatiques depuis une branche Git sont préférables pour les tests entre collègues.

### Limites de l’environnement de test

- Le service doit disposer d’une `DATABASE_URL` Neon accessible depuis Vercel. En l’absence de cette variable, le déploiement Vercel échoue plutôt que d’écrire dans un disque éphémère.
- La création et la modification de réservations utilisent une transaction et un verrou PostgreSQL par salle pour que deux requêtes concurrentes ne puissent pas réserver le même créneau.
- Les limites de fréquence de l’API sont conservées en mémoire par instance ; elles ne constituent pas un quota partagé entre plusieurs instances.
- Les comptes et données SQLite locaux ne sont pas transférés. Ne partage pas l’adresse de connexion Neon ou `JWT_SECRET`.

## Commandes et production

```powershell
npm run dev       # interface Vite et API Express en développement
npm run typecheck # vérification TypeScript
npm run build     # compilation de l’interface et du serveur
npm start         # serveur de production (après npm run build)
npm run admin:promote -- administrateur@epsi.fr # donner le rôle admin à un compte existant
npm run admin:demote -- administrateur@epsi.fr  # retirer le rôle admin
npm audit         # audit des dépendances
```

Arrête le serveur avant de modifier les rôles avec ces commandes, puis redémarre-le. Les commandes s’exécutent depuis la racine du projet.

Variables générales :

| Variable | Requise | Description |
| --- | --- | --- |
| `PORT` | Non | Port Express, par défaut `3001` |
| `JWT_SECRET` | Oui | Secret de signature d’au moins 32 caractères |
| `DATABASE_PATH` | Non | Chemin SQLite local, utilisé seulement sans `DATABASE_URL` |
| `DATABASE_URL` | Vercel / Neon | Chaîne privée de connexion Neon PostgreSQL |
| `NODE_ENV` | Non | Définir `production` pour la configuration de production |
| `VITE_EMAILJS_SERVICE_ID` | Pour l’e-mail | Identifiant du service EmailJS |
| `VITE_EMAILJS_TEMPLATE_ID` | Pour l’e-mail | Identifiant du modèle EmailJS |
| `VITE_EMAILJS_CONTACT_TEMPLATE_ID` | Pour le contact | Identifiant du modèle EmailJS de messagerie |
| `VITE_EMAILJS_PUBLIC_KEY` | Pour l’e-mail | Clé publique EmailJS autorisée pour le domaine |

Pour un serveur Node.js traditionnel, configure toutes les variables avant compilation, car Vite intègre les valeurs `VITE_` dans les fichiers client :

```powershell
npm run build
npm start
```

L’application est alors servie sur le port `3001` par défaut. Sur Vercel, les fichiers de `dist/client` et la fonction Express servent respectivement l’interface et les routes API ; il n’est pas nécessaire d’exécuter `npm start`.

## Dépannage

- **Aucun e-mail reçu** : contrôle les trois variables EmailJS, redémarre Vite, vérifie les identifiants et l’état du service/modèle dans EmailJS, puis inspecte les courriers indésirables et le tableau de bord du fournisseur.
- **EmailJS indique une origine non autorisée** : ajoute le domaine exact de l’application aux origines autorisées dans EmailJS.
- **Le courriel échoue mais la réservation existe** : c’est intentionnel ; corrige EmailJS puis réserve de nouveau seulement si un nouveau créneau est voulu. L’historique montre la réservation déjà prise en compte.
- **Port 5173 occupé** : utilise l’URL de remplacement indiquée par Vite ou libère le port avant de relancer.
- **Erreur JWT au démarrage** : configure `JWT_SECRET` dans `.env` avec au moins 32 caractères.
- **Salle non disponible** : essaie une autre durée, une autre heure ou une autre salle ; le conflit est contrôlé à nouveau lors de l’enregistrement.

## Structure du projet

```text
server/
  db.ts          Adaptateur SQLite/Neon, schéma et salles de démonstration
  index.ts       API Express, sessions, rôles admin, messagerie et réservations
  set-user-role.ts Promotion ou retrait du rôle administrateur
api/
  index.ts       Fonction Vercel et routage vers l’API Express
src/
  App.tsx        Écrans React, parcours étudiant et administration
  email.ts       E-mails de confirmation et de contact via EmailJS
  main.tsx       Point d’entrée React
  styles.css     Styles et adaptations responsive
index.html       Document HTML
vite.config.ts   Serveur Vite et proxy /api
vercel.json      Build, dossier statique et repli SPA Vercel
.env.example    Modèle des variables d’environnement
```
#   E p s i R e s e r v a t i o n s a l l e  
 