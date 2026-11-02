"""Pick five distinct HR interview prompts for one practice session."""

import random

HR_QUESTIONS = [
    "Where do you see yourself in 5 years?",
    "Tell me about a conflict or mistake.",
    "What are your weaknesses?",
    "Tell me about yourself.",
    "Why do you want to work at this company?",
    "How do you handle disagreement with a technical decision or team member?",
    "Describe a project you are most proud of.",
    "Tell me about a time you had to learn a new tool or technology quickly.",
]


def select_hr_questions(count: int = 5) -> list[str]:
    """Return a random sample without replacement."""
    return random.sample(HR_QUESTIONS, k=count)


if __name__ == "__main__":
    for number, question in enumerate(select_hr_questions(), start=1):
        print(f"{number}. {question}")
