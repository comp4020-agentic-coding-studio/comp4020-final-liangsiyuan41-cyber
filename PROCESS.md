# ANU TaskMate — Development Process

## 1. Project Idea and Goals

ANU TaskMate is a campus mutual-support platform designed for students at the Australian National University (ANU). Its purpose is to help students find assistance, share resources, and connect with other students.

My original idea was to create a website where students could post everyday requests, such as asking someone to collect takeaway food, looking for a second-hand calculator, or finding help to move heavy items. Users could offer a reward, and interested students could apply to help. Any payments would be arranged directly between students rather than through the platform.

However, as I developed the idea, I realised that campus support should not be limited to paid services. There are many valuable opportunities for students to connect without money being involved.

For example, a student could post an invitation asking whether anyone from COMP4020 would like to study together on Saturday. International students who want to improve their spoken English could look for local students interested in language exchange. Students could also find gym or running partners, while university clubs could promote activities and encourage more people to participate.

Therefore, I expanded ANU TaskMate into a platform covering campus help, study groups, social connections, and university events. Students can post both paid requests and free opportunities.

My goal is to encourage students to help each other, share resources, make friends, and feel more connected to campus life, rather than simply creating a marketplace for student labour.

Due to illness, I was unable to complete Crit 8 on time. Therefore, I prioritised building a minimum working version that could meet the requirements of Crit 9, with plans to expand the platform during the remaining Assignment 3 development period.

## 2. AI-Assisted Development Process

I mainly used Claude Code to assist with the programming.

Before starting development, I defined the main goals and features of the website. I then asked Claude to review the course project template and assignment requirements before proposing an implementation plan.

After reviewing the proposed plan, I decided to use Node.js, SQLite, and Server-Sent Events (SSE) for the backend, data storage, and real-time synchronisation.

I instructed Claude to develop the project in stages, run tests after each stage, and create separate Git commits so that the development process could be reviewed later.

Key development commits:

- [3c8fd08](https://github.com/comp4020-agentic-coding-studio/comp4020-final-liangsiyuan41-cyber/commit/3c8fd08) — Backend and database foundation.
- [da24998](https://github.com/comp4020-agentic-coding-studio/comp4020-final-liangsiyuan41-cyber/commit/da24998) — User interface, posting, and application features.
- [4520e13](https://github.com/comp4020-agentic-coding-studio/comp4020-final-liangsiyuan41-cyber/commit/4520e13) — Real-time synchronisation testing.

## 3. Key Design Decision

One important question during development was how the system should handle multiple students applying to the same opportunity.

A first-come, first-served approach would have been simple, but I felt it would not work well for every situation. For example, study groups and university events often welcome several participants rather than just one.

Therefore, I chose to allow different users to apply to the same post, while preventing the same user from submitting duplicate applications.

This design supports the community-focused purpose of ANU TaskMate while avoiding unnecessary duplicate records.

The decision is documented in ADR-001, included in commit [ceee28b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-liangsiyuan41-cyber/commit/ceee28b).

## 4. Problems and Solutions

One important issue appeared during the development of real-time synchronisation.

Claude identified that an earlier approach could potentially broadcast user-specific session information to other connected users.

To address this, the implementation was changed so that the server only broadcasts update notifications. Each browser then requests the latest information relevant to its own session.

This approach helps protect user information while keeping the website synchronised across different users.

This experience reminded me that even when AI-generated code appears to work, testing and reviewing the implementation are still necessary. Some problems are not immediately visible from the user interface.

## 5. Testing, Deployment, and Future Plans

Claude performed automated tests covering concurrent applications, duplicate application prevention, real-time synchronisation, and reconnection behaviour. All six automated tests passed.

I also personally tested the deployed website using a normal Chrome window and an incognito window. When I created a new post in one window, it appeared automatically in the other without refreshing. Application counts also updated in real time.

ANU TaskMate has now been deployed to Fly.io and supports the basic Crit 9 features, including paid and free posts, browsing campus opportunities, applying to participate, and real-time updates between users.

For the next stage of Assignment 3, I plan to introduce user accounts, applicant selection, reviews, reputation scores, and more complete campus activity management.

Through this development process, I learned that AI can make programming more efficient, but developers still need to define the project's purpose, make important design decisions, and personally verify that the final product works correctly.
