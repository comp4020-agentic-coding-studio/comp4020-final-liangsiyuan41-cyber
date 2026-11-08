# ANU TaskMate — Vision and Design Rationale

## 1. Vision and Purpose

I believe a university should not be a cold or lonely place. It should be a community where students feel welcome, make friends, and support one another.

For international students and those arriving in Canberra for the first time, everyday challenges can be difficult without familiar friends or support networks. Students from different countries may also rely on different social platforms, making it harder to find a shared space for connection.

Australia's multicultural character inspired my vision for ANU TaskMate. Regardless of nationality, language, or cultural background, students should have equal opportunities to ask for help, share experiences, and participate in campus life. I wanted to build more than a marketplace: a place where meaningful connections can begin.

## 2. What Makes TaskMate Good

A useful campus platform must support different needs without assuming every interaction is a paid transaction. I therefore designed four communities: Campus Help for everyday assistance, Study Together for learning and language exchange, Social Connect for friendships and shared interests, and Campus Events for clubs and activities.

Posts can be free or paid. This allows students to offer practical services while also organising study sessions, sports, and social activities without financial incentives.

I also consider a complete user journey essential. TaskMate supports creating posts, applying to participate, accepting or declining applicants, exchanging contact information, and completing or cancelling participation. Its value depends on helping students move from an online request to a real interaction.

## 3. Design Trade-offs and Privacy

Students communicate in different ways, so accepted participants may voluntarily share a phone number, email address, WhatsApp, or WeChat contact. No single messaging service is compulsory.

I considered an integrated chat system, but application messages and optional contact exchange addressed the immediate communication problem with less complexity. This was a deliberate choice to prioritise a working, manageable experience over a longer feature list.

Contact details are not public. Server-side permission checks restrict access to the relevant accepted participants, and access is restricted again after cancellation. Each user can apply only once to a particular post, reducing repetitive applications while allowing multiple students to join group opportunities.

## 4. How I Evaluate Quality

I distinguish between qualities the software can enforce and qualities that require human judgement.

**Enforced:** automated checks cover posting, applications, status changes, duplicate-application prevention, contact-access permissions, and data persistence. The project passed 80 automated tests and was deployed using GitHub Actions and Fly.io.

**Judged:** whether the interface feels welcoming, whether the four communities are understandable, and whether the workflow genuinely helps students require human evaluation. I tested different user journeys in Chrome and Safari and used those experiences to refine the design.

Importantly, a successful test suite cannot prove that TaskMate reduces loneliness or builds cross-cultural friendships. Those outcomes would need feedback from real students over time. My aim is to create the conditions for an inclusive, supportive campus community, while remaining honest about what the current prototype can demonstrate.
