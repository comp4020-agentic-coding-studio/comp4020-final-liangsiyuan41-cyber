## Crit 9 Reflection — ANU TaskMate

### 1. What was the breakthrough that moved the work forward?

The biggest breakthrough this week was getting ANU TaskMate to work as a real-time, multi-user application. Previously, most of my projects focused on interactions within a single browser. This time, I needed changes made by one user to appear automatically for everyone else.

With Claude Code's assistance, I implemented Server-Sent Events (SSE) to synchronise new posts and application counts. One important design decision was allowing multiple students to apply for the same opportunity without automatically closing it. This reflects my original idea of building a mutual-support community rather than a competitive task marketplace.

The most convincing moment was testing the deployed website myself using a normal browser window and an incognito window. Seeing the information update automatically without refreshing helped me understand how the different parts of a full-stack application work together.

### 2. What did this work change about who I want to be as a software developer?

This project reinforced my belief that software development should begin with understanding people's needs rather than choosing technologies or adding features.

My goal with ANU TaskMate is not simply to help students find paid tasks. I want to create opportunities for ANU students to help each other, find study partners, practise languages, and become more connected to campus life.

Working with Claude Code also made me think more carefully about my responsibility as a developer. AI can generate code and suggest technical solutions, but I still need to make design decisions, understand the trade-offs, and verify that the results actually work.

I want to become a developer who uses AI effectively while remaining responsible for the purpose, quality, and impact of the software I create.
