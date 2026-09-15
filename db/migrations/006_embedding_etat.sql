-- Empreinte de la configuration ayant servi a calculer les vecteurs stockes.
--
-- Raison d'etre: modifier le lexique (src/config/lexique.ts) change la façon
-- dont les notes sont vectorisees, mais les vecteurs deja en base ne bougent
-- pas. Le classement continue de fonctionner, sur des donnees perimees, sans
-- aucun signal. C'est le genre de panne qu'on ne voit pas et qui fait perdre
-- une soiree a chercher un bug ailleurs.
CREATE TABLE embedding_etat (
  cle         text PRIMARY KEY,
  signature   text NOT NULL,
  provider    text NOT NULL,
  dimension   int  NOT NULL,
  calcule_le  timestamptz NOT NULL DEFAULT now()
);
