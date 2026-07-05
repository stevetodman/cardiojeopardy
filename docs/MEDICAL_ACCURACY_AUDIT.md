# Medical Accuracy Audit

This app is an educational prototype, not clinical decision support. Case content should remain playable only when each case has a source trail and every ECG is labeled as synthetic unless a licensed real tracing is added.

## Current Case Sources

| Case | Key content checked | Source trail |
| --- | --- | --- |
| Innocent murmur | Still's murmur is soft/musical or vibratory, louder supine, softer or absent standing, and does not require treatment when clearly innocent. | AAFP heart murmur review; Cleveland Clinic Still's murmur; AAP Pediatric Care Online; peer-reviewed innocent murmur review. |
| Cyanotic CHD | d-TGA causes severe neonatal cyanosis, may have a normal/age-expected neonatal ECG, and PGE1 is used to maintain ductal patency while definitive care is arranged. | MSD Manual Professional; Cochrane PGE1 review; local `Park EKG.pdf`. |
| SVT | Stable pediatric SVT can be treated with vagal maneuvers and adenosine when access is available; unstable SVT requires synchronized cardioversion. | 2025 AHA/AAP PALS guideline; 2025 AHA PALS tachyarrhythmia algorithm. |
| Chest pain/pericarditis | Acute pericarditis is suggested by positional chest pain with diffuse ST elevation and/or PR depression; myocarditis risk should be considered with viral illness/chest pain patterns. | ESC pericarditis diagnosis review; ECG Diagnosis acute pericarditis review; Hopkins pediatric chest pain troponin pathway. |
| Exertional syncope/long QT | Exertional syncope, family history of sudden death, and prolonged QTc are high-risk features that require urgent evaluation and sports restriction pending cardiology review. | Local pediatric syncope review; local `Park EKG.pdf`; UCSF long QT overview; ACC long QT exercise discussion for shared decision context. |
| Post-op CHD complication | Post-cardiotomy fever/chest pain/effusion raises concern for postpericardiotomy syndrome; effusion/tamponade is evaluated with echocardiography and can cause hemodynamic compromise. | Postpericardiotomy syndrome review; CHOP pericarditis in children; Merck Manual Professional pericarditis; local `Park EKG.pdf`. |

## Source Rules

- Prefer guidelines, major pediatric centers, peer-reviewed reviews, and established pediatric cardiology texts.
- Record source URLs or local file paths in the case JSON `references` array.
- Treat every synthetic ECG as an educational drawing. Do not let it imply a patient tracing.
- Re-run `npm run typecheck`, `npm test`, `npm run lint`, and browser QA after changing case content.

## Known Limitation

The content is source-backed and test-enforced, but it has not been formally reviewed or clinically validated by a pediatric cardiologist. Do not market it as a validated medical education product until that review happens.
