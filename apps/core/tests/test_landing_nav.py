from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

User = get_user_model()


class LandingAuthNavTests(TestCase):
    def setUp(self):
        self.customer = User.objects.create_user(
            email="landing-customer@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )

    def test_logged_in_customer_gets_landing_not_redirect(self):
        self.client.force_login(self.customer)
        response = self.client.get(reverse("home"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "How it works")
        self.assertContains(response, "Gallery")
        self.assertContains(response, "What customers say")
        self.assertContains(response, "FAQ")
        self.assertContains(response, 'id="contact"')

    def test_customer_navbar_has_home_and_dashboard(self):
        self.client.force_login(self.customer)
        response = self.client.get(reverse("app_home"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'aria-label="Customer"')
        self.assertContains(response, ">Home</a>")
        self.assertContains(response, ">Dashboard</a>")
        self.assertContains(response, f'href="{reverse("home")}"')
        self.assertContains(response, f'href="{reverse("app_home")}"')

    def test_logged_out_navbar_has_no_dashboard(self):
        response = self.client.get(reverse("home"))
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, ">Dashboard</a>")
        self.assertContains(response, "Log in")
        self.assertContains(response, "Sign up")

    def test_hero_button_target_differs_by_auth(self):
        logged_out = self.client.get(reverse("home"))
        self.assertContains(logged_out, 'href="/accounts/login/"')
        self.assertContains(logged_out, "Sign in to start designing")

        self.client.force_login(self.customer)
        logged_in = self.client.get(reverse("home"))
        self.assertContains(logged_in, f'action="{reverse("design_create")}"')
        self.assertNotContains(logged_in, "Sign in to start designing")
        self.assertContains(logged_in, "Go to dashboard")
        self.assertNotContains(logged_in, "Create an account")
