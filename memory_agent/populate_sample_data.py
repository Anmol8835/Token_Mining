"""Populate memory-agent with a diverse random sample of prompt+response pairs for testing."""
import random
import sys
import requests

BASE = "http://127.0.0.1:5090"
USER_ID = sys.argv[1] if len(sys.argv) > 1 else "testuser1"

TOPICS = {
    "geography_trivia": [
        ("What is the capital of Australia?", "Canberra is the capital of Australia."),
        ("Which river is the longest in the world?", "The Nile is generally considered the longest river in the world, at roughly 6,650 km."),
        ("How many countries border Germany?", "Germany borders nine countries."),
        ("What is the highest mountain in Africa?", "Mount Kilimanjaro in Tanzania is the highest peak in Africa, at 5,895 meters."),
        ("Name the smallest country in the world.", "Vatican City is the smallest country in the world by area."),
    ],
    "science": [
        ("What causes the aurora borealis?", "It's caused by charged particles from the sun colliding with gases in Earth's atmosphere near the poles."),
        ("Explain photosynthesis in simple terms.", "Plants use sunlight, water, and CO2 to produce glucose and oxygen."),
        ("Why is the sky blue?", "Air molecules scatter shorter blue wavelengths of sunlight more than other colors, an effect called Rayleigh scattering."),
        ("What is the difference between speed and velocity?", "Speed is a scalar (magnitude only); velocity is a vector (magnitude and direction)."),
        ("How do vaccines work?", "They train the immune system to recognize a pathogen by exposing it to a harmless piece or weakened form of it."),
    ],
    "coding": [
        ("Write a Python function to check if a number is prime.", "def is_prime(n):\n    if n < 2: return False\n    return all(n % i for i in range(2, int(n**0.5)+1))"),
        ("How do I reverse a string in JavaScript?", "str.split('').reverse().join('')"),
        ("Explain the difference between REST and GraphQL.", "REST exposes fixed endpoints per resource; GraphQL lets the client specify exactly which fields it needs in one query."),
        ("What is a race condition in concurrent programming?", "It's when the outcome depends on the unpredictable timing of concurrent operations accessing shared state."),
        ("How does garbage collection work in Java?", "The JVM automatically reclaims memory occupied by objects that are no longer reachable from any live reference."),
    ],
    "cooking": [
        ("How do I make a basic tomato sauce from scratch?", "Saute garlic in olive oil, add crushed tomatoes, simmer 20-30 minutes, season with salt, basil, and pepper."),
        ("What's the difference between baking soda and baking powder?", "Baking soda needs an acid to activate; baking powder already contains an acid and just needs moisture/heat."),
        ("How long should I marinate chicken for grilling?", "At least 30 minutes, ideally 2-4 hours; beyond 24 hours the texture can turn mushy."),
        ("What temperature should bread be baked at?", "Most bread bakes well at 190-230°C (375-450°F), depending on the recipe."),
        ("How do I keep avocados from browning?", "Add lemon or lime juice, and press plastic wrap directly against the cut surface to limit air exposure."),
    ],
    "history": [
        ("What caused the fall of the Roman Empire?", "A combination of economic decline, military overextension, political instability, and invasions by various groups."),
        ("Who was the first emperor of China?", "Qin Shi Huang unified China and became its first emperor in 221 BCE."),
        ("When did the Berlin Wall fall?", "The Berlin Wall fell on November 9, 1989."),
        ("What were the main causes of World War I?", "Militarism, alliances, imperialism, and nationalism, triggered by the assassination of Archduke Franz Ferdinand."),
        ("Who signed the Declaration of Independence?", "56 delegates to the Continental Congress signed it, including John Hancock and Thomas Jefferson."),
    ],
    "personal_finance": [
        ("What is the difference between a Roth IRA and a traditional IRA?", "Roth contributions are after-tax with tax-free withdrawals; traditional contributions are pre-tax with taxed withdrawals."),
        ("How much should I save for an emergency fund?", "A common guideline is 3-6 months of essential living expenses."),
        ("What is compound interest?", "Interest calculated on both the initial principal and the accumulated interest from previous periods."),
        ("Should I pay off debt or invest first?", "Generally pay off high-interest debt first, then invest — the math favors whichever has the higher rate."),
        ("How does a mortgage amortization schedule work?", "Early payments go mostly toward interest; over time, a larger share goes toward the principal."),
    ],
    "casual_chat": [
        ("yo what's a good movie to watch tonight", "depends on your mood — something like Inception if you want a mind-bender, or a comfort rewatch if you just want to chill"),
        ("im bored, suggest something fun to do", "go for a walk, try a new recipe, or start that show everyone keeps talking about"),
        ("whats the weather usually like in autumn", "cooler temps, shorter days, and a lot more rain/wind depending on where you are"),
        ("give me a random fun fact", "octopuses have three hearts, and two of them stop beating when they swim"),
        ("whats your favorite kind of music", "I don't have personal preferences, but I can help you find something based on your mood!"),
    ],
    "business": [
        ("How do I write a good elevator pitch for a startup?", "State the problem, your solution, who it's for, and why now — aim for under 30 seconds."),
        ("What's the difference between B2B and B2C sales?", "B2B sells to businesses with longer cycles and multiple stakeholders; B2C sells to individual consumers, usually faster."),
        ("How do I calculate customer lifetime value?", "Average purchase value x purchase frequency x customer lifespan (minus acquisition/retention costs for a fuller picture)."),
        ("What is a SWOT analysis used for?", "It's a framework for evaluating Strengths, Weaknesses, Opportunities, and Threats in strategic planning."),
        ("How should I price a SaaS product?", "Common approaches: cost-plus, value-based, or competitor-based pricing, often combined with usage or seat-based tiers."),
    ],
}

random.seed()  # true randomness, not a fixed seed — different each run
all_pairs = [(topic, prompt, response) for topic, plist in TOPICS.items() for prompt, response in plist]
random.shuffle(all_pairs)

print(f"Populating {len(all_pairs)} prompt+response pairs for user '{USER_ID}' across {len(TOPICS)} topics, in random order...")
for topic, prompt, response in all_pairs:
    resp = requests.post(f"{BASE}/v1/store", json={"user_id": USER_ID, "prompt": prompt, "response": response})
    d = resp.json()
    print(f"[{topic:18}] stored #{d.get('stored_id')}: {prompt[:55]}")

health = requests.get(f"{BASE}/v1/settings?user_id={USER_ID}").json()
print(f"\nFinal state: {health['memory_size']} entries, {health['memory_bytes']} bytes")
