# Envoyer les emails de vérification depuis `g0x.dev`

*Comment brancher l'envoi d'emails du serveur alors que `g0x.dev` reçoit déjà
son courrier chez Proton.*

---

## Le problème, en une phrase

Proton gère très bien la **réception** sur `g0x.dev` — c'est ce que font les
enregistrements déjà en place chez Cloudflare (MX, SPF, les trois CNAME DKIM,
DMARC). Mais un serveur qui envoie un lien de confirmation a besoin de
**crédentiels SMTP sortants**, et Proton n'en donne pas avec un compte
personnel : la boîte est chiffrée de bout en bout, il n'y a pas de mot de passe
SMTP à récupérer dans les réglages.

Trois façons d'en obtenir. La troisième est celle que je recommande ici.

> **En attendant**, le serveur tourne avec `MAIL_TRANSPORT=log` : les liens de
> confirmation sont écrits dans le journal (`journalctl -u open-grunker | grep
> mail:log`) au lieu d'être envoyés, et `EMAIL_VERIFY_ENFORCE=false` laisse
> jouer les comptes non confirmés. Rien n'est cassé, la vérification n'est
> simplement pas encore contraignante.

---

## Option 1 — Proton SMTP submission *(propre, mais plan Business)*

Proton expose un vrai SMTP sortant, avec des **jetons de soumission**. C'est
fait exactement pour ça : un serveur qui envoie du transactionnel.

- Disponible sur les offres **Proton Business** (Mail Essentials, Business
  Suite). **Pas** sur Mail Plus ni Unlimited.
- Réglages Proton → *IMAP/SMTP* → *SMTP submission* → générer un jeton pour
  l'adresse d'envoi.
- Aucun enregistrement DNS à ajouter : le SPF et le DKIM de Proton déjà en
  place couvrent l'envoi.

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.protonmail.ch
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=no-reply@g0x.dev        # l'adresse, pas le jeton
SMTP_PASS=<le jeton généré>
MAIL_FROM=no-reply@g0x.dev
```

**Pour :** rien à toucher côté DNS, tout reste chez Proton.
**Contre :** il faut passer sur une offre Business.

---

## Option 2 — Proton Mail Bridge sur cette machine *(pénible sur un Pi)*

Bridge est l'application Proton qui déchiffre localement et expose un SMTP sur
`127.0.0.1`. Elle marche avec n'importe quelle offre payante, y compris Mail
Plus.

Le souci ici est la machine : c'est un **Raspberry Pi 5, donc ARM64**, et
Proton ne publie de paquets officiels que pour x86_64. Il faut compiler
`github.com/ProtonMail/proton-bridge` soi-même, le lancer en mode sans
interface (`protonmail-bridge --noninteractive`), s'authentifier une première
fois à la main (2FA comprise) et le maintenir vivant sous systemd.

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=1025                    # le port par défaut de Bridge
SMTP_STARTTLS=true
SMTP_TLS_REJECT_UNAUTHORIZED=false   # Bridge présente un certificat auto-signé
SMTP_USER=<ton adresse Proton>
SMTP_PASS=<le mot de passe Bridge, pas celui du compte>
```

**Pour :** marche avec l'offre payante que tu as peut-être déjà.
**Contre :** un démon de plus à compiler, surveiller et ré-authentifier. Si
Bridge tombe, les inscriptions ne partent plus.

---

## Option 3 — un service transactionnel sur un sous-domaine *(recommandé)*

Garder Proton pour **recevoir** sur `g0x.dev`, et confier l'**envoi** du jeu à
un service transactionnel, sur un sous-domaine dédié : `send.g0x.dev`. Les
enregistrements Proton existants ne sont jamais touchés, et les deux systèmes
ne peuvent pas se marcher dessus.

Resend, Brevo, Mailjet, SMTP2GO, Postmark, Amazon SES font tous l'affaire.
Leurs offres gratuites tournent autour de la centaine d'emails par jour — très
au-dessus de ce qu'un serveur de jeu consomme en confirmations de compte.
Vérifie le quota du jour chez celui que tu choisis.

### Ce qu'il faut ajouter chez Cloudflare

Tout en **DNS uniquement** (nuage gris), comme le reste de tes enregistrements
mail. Les valeurs exactes viennent du fournisseur — ce sont les *formes* qui
comptent :

| Nom | Type | Valeur | Note |
| --- | --- | --- | --- |
| `send.g0x.dev` | TXT | `v=spf1 include:<spf-du-fournisseur> ~all` | SPF **du sous-domaine seulement** |
| `<sélecteur>._domainkey.send.g0x.dev` | CNAME ou TXT | fourni par le service | la clé DKIM |
| `_dmarc.send.g0x.dev` | TXT | `v=DMARC1; p=quarantine; rua=mailto:toi@g0x.dev` | facultatif mais recommandé |
| `send.g0x.dev` | MX | seulement si le fournisseur le demande | pour les retours (SES, par ex.) |

Puis dans `.env` :

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=<smtp du fournisseur>   # ex. smtp.resend.com, smtp-relay.brevo.com
SMTP_PORT=587                     # ou 465 avec SMTP_SECURE=true
SMTP_STARTTLS=true
SMTP_USER=<utilisateur ou "apikey">
SMTP_PASS=<la clé API>
MAIL_FROM=no-reply@send.g0x.dev   # doit être sur le domaine vérifié
MAIL_FROM_NAME=Open Grunker
MAIL_REPLY_TO=contact@g0x.dev     # une vraie adresse Proton, si tu veux des réponses
```

### Les trois pièges

1. **Ne touche pas aux enregistrements du domaine racine.** Les trois CNAME
   `protonmail*._domainkey.g0x.dev`, les deux MX, le SPF et le
   `protonmail-verification` restent exactement tels quels. Un sous-domaine
   d'envoi existe précisément pour ne pas avoir à y toucher.

2. **Jamais deux enregistrements SPF sur un même nom.** C'est une erreur qui
   fait échouer le SPF entièrement, pas qui l'additionne. Si tu préfères
   envoyer depuis `no-reply@g0x.dev` (la racine) plutôt que depuis le
   sous-domaine, il faut **modifier** le TXT existant, pas en ajouter un :

   ```
   v=spf1 include:_spf.protonmail.ch include:<spf-du-fournisseur> ~all
   ```

3. **Ton DMARC racine est en `p=quarantine`, et il s'applique aux
   sous-domaines** (il n'y a pas de `sp=` pour l'assouplir). Un message envoyé
   depuis `send.g0x.dev` doit donc être signé DKIM pour ce sous-domaine — ce
   que fait le fournisseur une fois le DKIM ci-dessus en place. C'est
   l'alignement DKIM qui fait passer DMARC ; ne saute pas cette étape.

---

## Vérifier, puis activer

Un test d'envoi, avec la configuration réelle du `.env` :

```bash
npm run mail:test -- ton.adresse@example.com
```

Le script affiche le serveur, le port, le chiffrement et l'expéditeur qu'il
s'apprête à utiliser, puis livre — ou explique pourquoi il n'a pas pu, avec les
mots du serveur SMTP.

Quand un message arrive bien dans une boîte (et pas dans les indésirables),
serrer la vis :

```ini
MAIL_TRANSPORT=smtp
EMAIL_VERIFY_ENFORCE=true     # un compte non confirmé n'entre plus en partie
```

```bash
sudo systemctl restart open-grunker
```

Les deux comptes qui existaient avant cette fonctionnalité (`g0x`, `RODAN`) ont
été marqués confirmés par la migration : ils avaient une adresse et se sont
inscrits sous des règles qui ne leur demandaient rien. Personne n'est enfermé
dehors par ce changement.

### Si ça part en indésirables

Dans l'ordre d'importance : DKIM aligné sur le domaine d'envoi, SPF qui
autorise le fournisseur, DMARC cohérent, adresse `MAIL_FROM` sur le domaine
vérifié, et un `Reply-To` qui existe vraiment. Le serveur envoie déjà un
`Message-ID`, une `Date`, un `Auto-Submitted: auto-generated` et une partie
texte en plus du HTML — le reste se joue dans le DNS.
