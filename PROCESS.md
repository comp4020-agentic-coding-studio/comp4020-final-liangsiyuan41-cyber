# ANU TaskMate — Development Process

## 1. Project Idea and Goals

ANU TaskMate is a campus mutual-support platform designed to help students at the Australian National University (ANU) with their academic, everyday, and social needs.

My initial idea came from considering the difficulties faced by international students and those arriving in Canberra for the first time. When they encounter problems, they may not have friends or a support network to turn to. I believed a platform offering both free and paid assistance could help address this problem.

Initially, I focused on practical services such as collecting takeaway food, finding second-hand items, and moving furniture. However, I gradually realised that this idea was too limited. Campus support could also involve study groups, language exchange, sports partners, social activities, and university clubs.

I therefore expanded the platform into four communities: Campus Help, Study Together, Social Connect, and Campus Events. Each post can be free or paid, depending on its purpose.

My goal was to create a platform that genuinely supports students across different aspects of university life, rather than simply becoming a marketplace for paid tasks.

## 2. AI-Assisted Development Process

Due to illness, I could not complete Crit 8 on time. For Crit 9, I prioritised building a minimum working version before expanding its functionality for the Final Project.

I primarily used Claude Code for implementation. My responsibility was to define product goals, explain requirements, evaluate results, and decide what needed improvement. Claude assisted with coding, testing, and deployment.

The project uses Node.js, SQLite, and Server-Sent Events (SSE) for posting, applications, persistent storage, and real-time updates. Development was organised into stages, with Git commits preserving evidence of progress. Early implementation is recorded in commits `3c8fd08`, `da24998`, and `4520e13`.

After establishing the basic functions, I introduced applicant management, including accepting and declining applications, completion, and cancellation workflows.

I then reconsidered the interface. The original design resembled a simple list of posts and did not clearly communicate the platform's different purposes. I introduced separate community pages, improved navigation, and dedicated Create Post and My Activity pages.

For V1.1, I added application messages and private contact exchange so that accepted participants could communicate and arrange activities. This development is reflected in commit `90b99ec`.

Rather than asking AI to build everything at once, I repeatedly reviewed the working product, identified missing functionality, and refined the requirements before continuing development.

## 3. Key Design Decisions

One important decision concerned multiple students applying to the same post.

A first-come, first-served system would have been simple but unsuitable for study groups or campus activities involving several participants. I therefore allowed multiple applicants while preventing the same user from repeatedly applying to one post, including after rejection.

I also chose to manage each applicant's participation status separately instead of treating an entire post as one completed task. This allows organisers to manage participants independently.

Another significant decision emerged during manual testing. Although a poster could accept an application, the participants had no practical way to contact each other. The application system worked technically, but the real-world interaction remained incomplete.

I considered a full messaging system but decided that application messages and optional contact sharing were more appropriate for the project's timeframe.

Because ANU has an international student community, I included phone numbers, email, WhatsApp, and WeChat rather than relying on one communication method.

Privacy was equally important. Contact details are accessible only to the relevant accepted participants who choose to share them, with access restricted again after cancellation.

These decisions balanced usability, privacy, development scope, and the platform's original purpose.

## 4. Challenges and Reflections on AI-Assisted Development

One of the most important lessons I learned was that AI can implement requested features without necessarily understanding whether the overall design is reasonable or meets users' actual needs.

To address this limitation, I conducted extensive manual testing in my local development environment. Rather than simply checking whether individual functions worked, I tried to put myself in the position of different students and consider what they would genuinely need from the platform.

This approach revealed problems that were not obvious from the code or automated test results.

For example, although the initial application workflow worked, accepted participants could not contact each other. I therefore introduced application messages and optional contact sharing to make the platform useful beyond the website itself.

I also reconsidered repeated applications and potential harassment, leading to the rule that a user cannot repeatedly apply to the same post. For privacy, I required Claude to implement server-side permission checks instead of merely hiding contact information in the interface.

These were not simply programming problems. They required decisions about how the platform should behave and whose interests it should protect. Claude could implement the chosen rules, but I needed to determine which rules were appropriate.

I also learned that automated tests cannot identify requirements that were never considered. Even when tests passed, realistic user journeys could reveal missing functionality.

As a result, I developed a more structured approach to AI-assisted development: define realistic user scenarios, guide AI implementation, manually test the complete experience, and refine the system according to users' actual needs.

## 5. Testing, Deployment, and Future Development

I used Chrome and Safari to simulate different users and test posting, applying, accepting, declining, completing, and cancelling participation.

For V1.1, I tested whether accepted participants could save and view each other's shared contact details. I also checked practical interface features, including copying contact information.

The application passed 80 automated tests and was deployed through GitHub Actions and Fly.io. Before deploying database changes, I required backups and compatibility checks to protect existing posts and applications.

I also added an academic integrity reminder to Study Together, encouraging collaboration while discouraging plagiarism and other misconduct. This change is recorded in commit `54a69b8`.

ANU TaskMate now supports a basic workflow from publishing requests and selecting participants to exchanging contact information and completing activities.

Future improvements could include user accounts, profiles, ratings, and a reputation system.

This project changed how I view AI-assisted development. AI can accelerate implementation, but it cannot replace human understanding of user needs, product decisions, or responsibility for the final result. I learned that effective software development is not simply about producing more code, but ensuring that the software genuinely helps its users.
